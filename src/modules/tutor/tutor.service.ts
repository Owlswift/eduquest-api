import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClassLevel, LessonState, TutorMessageRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { TutorLlmService, TutorHistoryEntry } from './tutor-llm.service';
import { TutorTurn } from './tutor-schema';
import { VoiceSttService } from '../voice/voice-stt.service';

/**
 * Deterministic lesson state machine. The LLM only ever proposes a signal
 * (ADVANCE / RETRY / STRUGGLING) for the current turn - EduQuest, not the
 * model, decides what stage the lesson moves to next.
 */
function nextState(
  current: LessonState,
  signal: TutorTurn['studentSignal'],
): LessonState {
  switch (current) {
    case LessonState.INTRODUCTION:
      // The intro turn always contains the diagnostic question; the
      // student's reply to it is evaluated as prior-knowledge assessment.
      return LessonState.ASSESS_PRIOR_KNOWLEDGE;
    case LessonState.ASSESS_PRIOR_KNOWLEDGE:
      return signal === 'ADVANCE' ? LessonState.EXPLAIN_CONCEPT : current;
    case LessonState.EXPLAIN_CONCEPT:
      return signal === 'ADVANCE' ? LessonState.EXAMPLE : current;
    case LessonState.EXAMPLE:
      return signal === 'ADVANCE' ? LessonState.CHECK_UNDERSTANDING : current;
    case LessonState.CHECK_UNDERSTANDING:
      if (signal === 'ADVANCE') return LessonState.MINI_QUIZ;
      if (signal === 'STRUGGLING') return LessonState.EXPLAIN_CONCEPT;
      return current;
    case LessonState.MINI_QUIZ:
      return signal === 'ADVANCE' ? LessonState.COMPLETED : current;
    case LessonState.COMPLETED:
      return current;
  }
}

function blocksToText(blocks: TutorTurn['blocks']): string {
  return blocks.map((b) => b.content).join('\n\n');
}

// ASSESS_PRIOR_KNOWLEDGE is meant to last "2-3 exchanges" per the tutor
// prompt, but that's only ever a suggestion to the LLM - if the student
// keeps answering "I don't know", the model tends to keep probing forever
// instead of moving on to actually teach the concept. Cap it here so the
// state machine (not the LLM's discretion) guarantees forward progress,
// consistent with EduQuest owning every state transition.
const ASSESS_PRIOR_KNOWLEDGE_TURN_CAP = 3;

function capSignal(
  state: LessonState,
  signal: TutorTurn['studentSignal'],
  studentTurnsInState: number,
): TutorTurn['studentSignal'] {
  if (
    state === LessonState.ASSESS_PRIOR_KNOWLEDGE &&
    studentTurnsInState >= ASSESS_PRIOR_KNOWLEDGE_TURN_CAP
  ) {
    return 'ADVANCE';
  }
  return signal;
}

@Injectable()
export class TutorService {
  constructor(
    private prisma: PrismaService,
    private llm: TutorLlmService,
    private stt: VoiceSttService,
    private activity: ActivityService,
  ) {}

  /** Records a lesson interaction toward today's study activity/streak,
   *  swallowing errors so activity tracking never breaks a lesson turn. */
  private trackLesson(userId: string): void {
    void this.activity.recordLesson(userId).catch(() => {});
  }

  // ─── POST /tutor/sessions ───────────────────────────────────────────────

  async startSession(
    userId: string,
    params: { subjectId: string; classLevel: ClassLevel; topicId: string },
  ) {
    this.trackLesson(userId);
    const topic = await this.prisma.curriculumTopic.findUnique({
      where: { id: params.topicId },
      include: { subject: true },
    });
    if (
      !topic ||
      topic.subjectId !== params.subjectId ||
      topic.classLevel !== params.classLevel
    ) {
      throw new NotFoundException(
        'Curriculum topic not found for this subject/class level',
      );
    }

    const mastery = await this._getOrCreateMastery(
      userId,
      topic.id,
      params.subjectId,
      params.classLevel,
    );

    const existingSession = await this.prisma.tutorSession.findFirst({
      where: {
        userId,
        topicId: topic.id,
        subjectId: params.subjectId,
        classLevel: params.classLevel,
        state: { not: LessonState.COMPLETED },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existingSession) {
      const messages = await this.prisma.tutorMessage.findMany({
        where: { sessionId: existingSession.id },
        orderBy: { createdAt: 'asc' },
      });
      return {
        session: existingSession,
        message: messages[messages.length - 1],
        messages,
      };
    }

    const session = await this.prisma.tutorSession.create({
      data: {
        userId,
        subjectId: params.subjectId,
        classLevel: params.classLevel,
        topicId: topic.id,
        state: LessonState.INTRODUCTION,
        masteryAtStart: mastery.masteryScore,
        weakAreasAtStart: mastery.weakAreas ?? [],
      },
    });

    const turn = await this.llm.generateTurn({
      state: LessonState.INTRODUCTION,
      topic: this._topicContext(topic, topic.subject.name, params.classLevel),
      masteryScore: mastery.masteryScore,
      weakAreas: (mastery.weakAreas as string[] | null) ?? [],
      history: [],
    });

    const message = await this._persistTutorTurn(
      session.id,
      LessonState.INTRODUCTION,
      turn,
    );
    await this._applyMasteryFeedback(mastery.id, turn);

    const updatedSession = await this.prisma.tutorSession.update({
      where: { id: session.id },
      data: { state: nextState(LessonState.INTRODUCTION, turn.studentSignal) },
    });

    return { session: updatedSession, message };
  }

  // ─── POST /tutor/sessions/:id/messages ──────────────────────────────────

  async postMessage(userId: string, sessionId: string, content: string) {
    const session = await this._getOwnedSession(userId, sessionId);
    if (session.state === LessonState.COMPLETED) {
      throw new ForbiddenException('This lesson has already been completed');
    }
    this.trackLesson(userId);

    await this.prisma.tutorMessage.create({
      data: {
        sessionId,
        role: TutorMessageRole.STUDENT,
        content,
        stateAt: session.state,
      },
    });

    const mastery = await this._getOrCreateMastery(
      userId,
      session.topicId,
      session.subjectId,
      session.classLevel,
    );

    const history = await this._recentHistory(sessionId);

    const turn = await this.llm.generateTurn({
      state: session.state,
      topic: this._topicContext(
        session.topic,
        session.topic.subject.name,
        session.classLevel,
      ),
      masteryScore: mastery.masteryScore,
      weakAreas: (mastery.weakAreas as string[] | null) ?? [],
      history,
      studentMessage: content,
    });

    const message = await this._persistTutorTurn(
      sessionId,
      session.state,
      turn,
    );
    await this._applyMasteryFeedback(mastery.id, turn);

    const studentTurnsInState = await this.prisma.tutorMessage.count({
      where: {
        sessionId,
        role: TutorMessageRole.STUDENT,
        stateAt: session.state,
      },
    });
    const signal = capSignal(session.state, turn.studentSignal, studentTurnsInState);
    const resolvedState = nextState(session.state, signal);

    // The COMPLETED state's wrap-up (encouragement + flashcards) is only
    // ever the *next* turn after a MINI_QUIZ ADVANCE, and postMessage
    // refuses further input once a session is COMPLETED - so it must be
    // generated here, in the same request that crosses into COMPLETED,
    // or it would never run at all.
    let completionMessage: Awaited<
      ReturnType<typeof this._persistTutorTurn>
    > | null = null;
    if (resolvedState === LessonState.COMPLETED) {
      const completionTurn = await this.llm.generateTurn({
        state: LessonState.COMPLETED,
        topic: this._topicContext(
          session.topic,
          session.topic.subject.name,
          session.classLevel,
        ),
        masteryScore: mastery.masteryScore,
        weakAreas: (mastery.weakAreas as string[] | null) ?? [],
        history: await this._recentHistory(sessionId),
      });
      completionMessage = await this._persistTutorTurn(
        sessionId,
        LessonState.COMPLETED,
        completionTurn,
      );
      await this._applyMasteryFeedback(mastery.id, completionTurn);
    }

    const updatedSession = await this.prisma.tutorSession.update({
      where: { id: sessionId },
      data: {
        state: resolvedState,
        completedAt:
          resolvedState === LessonState.COMPLETED ? new Date() : null,
      },
    });

    return { session: updatedSession, message, completionMessage };
  }

  // ─── POST /tutor/sessions/:id/skip-assessment ───────────────────────────

  /** Lets the student jump straight to teaching without answering more
   * prior-knowledge questions - same idea as the ASSESS_PRIOR_KNOWLEDGE turn
   * cap in postMessage, but as an explicit student choice rather than a
   * fallback after too many turns. */
  async skipAssessment(userId: string, sessionId: string) {
    const session = await this._getOwnedSession(userId, sessionId);
    if (session.state !== LessonState.ASSESS_PRIOR_KNOWLEDGE) {
      throw new ForbiddenException(
        'Assessment can only be skipped during the prior-knowledge check',
      );
    }
    this.trackLesson(userId);

    const mastery = await this._getOrCreateMastery(
      userId,
      session.topicId,
      session.subjectId,
      session.classLevel,
    );

    const turn = await this.llm.generateTurn({
      state: LessonState.EXPLAIN_CONCEPT,
      topic: this._topicContext(
        session.topic,
        session.topic.subject.name,
        session.classLevel,
      ),
      masteryScore: mastery.masteryScore,
      weakAreas: (mastery.weakAreas as string[] | null) ?? [],
      history: await this._recentHistory(sessionId),
    });

    const message = await this._persistTutorTurn(
      sessionId,
      LessonState.EXPLAIN_CONCEPT,
      turn,
    );
    await this._applyMasteryFeedback(mastery.id, turn);

    // Stay in EXPLAIN_CONCEPT - the student hasn't responded to this new
    // content yet, so there's no real signal to advance on.
    const updatedSession = await this.prisma.tutorSession.update({
      where: { id: sessionId },
      data: { state: LessonState.EXPLAIN_CONCEPT },
    });

    return { session: updatedSession, message };
  }

  // ─── POST /tutor/sessions/:id/voice-messages ────────────────────────────

  async postVoiceMessage(
    userId: string,
    sessionId: string,
    audioBuffer: Buffer,
    mimeType: string,
  ) {
    const transcript = await this.stt.transcribe(audioBuffer, mimeType);
    if (!transcript) {
      throw new BadRequestException(
        "Couldn't make out any speech in that recording - please try again",
      );
    }
    const result = await this.postMessage(userId, sessionId, transcript);
    return { transcript, ...result };
  }

  // ─── GET /tutor/sessions/:id ─────────────────────────────────────────────

  async getSession(userId: string, sessionId: string) {
    const session = await this._getOwnedSession(userId, sessionId);
    const messages = await this.prisma.tutorMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    return { session, messages };
  }

  // ─── GET /tutor/sessions/:id/flashcards ──────────────────────────────────

  async getFlashcards(userId: string, sessionId: string) {
    await this._getOwnedSession(userId, sessionId);
    const messages = await this.prisma.tutorMessage.findMany({
      where: { sessionId, role: TutorMessageRole.TUTOR },
      orderBy: { createdAt: 'asc' },
    });

    return messages.flatMap((m) => {
      const blocks = (m.blocks as TutorTurn['blocks'] | null) ?? [];
      return blocks
        .filter((b) => b.type === 'flashcard')
        .map((b) => ({ front: b.content, back: b.back ?? '' }));
    });
  }

  // ─── GET /tutor/messages/:messageId/audio ────────────────────────────────

  async getMessageTextForAudio(userId: string, messageId: string) {
    const message = await this._getOwnedTutorMessage(userId, messageId);
    return message.content;
  }

  // ─── GET /tutor/messages/:messageId/diagram ──────────────────────────────

  async getMessageDiagram(userId: string, messageId: string) {
    const message = await this._getOwnedTutorMessage(userId, messageId);
    const blocks = (message.blocks as TutorTurn['blocks'] | null) ?? [];
    const diagram = blocks.find((b) => b.type === 'diagram');
    if (!diagram) {
      throw new NotFoundException('This message has no diagram block');
    }
    // The model occasionally puts Mermaid syntax straight into `content`
    // instead of the dedicated `mermaidCode` field - fall back to treating
    // `content` as the code if it's clearly Mermaid syntax rather than a
    // plain-English caption.
    const looksLikeMermaid = /^(graph|flowchart)\s/i.test(
      diagram.content.trim(),
    );
    const mermaidCode =
      diagram.mermaidCode ?? (looksLikeMermaid ? diagram.content : undefined);
    if (!mermaidCode) {
      throw new NotFoundException(
        'This diagram block has no renderable Mermaid code',
      );
    }
    return {
      mermaidCode,
      description: looksLikeMermaid ? undefined : diagram.content,
    };
  }

  // ─── GET /tutor/messages/:messageId/illustration ─────────────────────────

  async getMessageIllustrationPrompt(userId: string, messageId: string) {
    const message = await this._getOwnedTutorMessage(userId, messageId);
    const blocks = (message.blocks as TutorTurn['blocks'] | null) ?? [];
    const illustration = blocks.find((b) => b.type === 'illustration');
    if (!illustration) {
      throw new NotFoundException('This message has no illustration block');
    }
    return illustration.content;
  }

  private async _getOwnedTutorMessage(userId: string, messageId: string) {
    const message = await this.prisma.tutorMessage.findUnique({
      where: { id: messageId },
      include: { session: true },
    });
    if (!message) throw new NotFoundException('Tutor message not found');
    if (message.session.userId !== userId) {
      throw new ForbiddenException('This tutor message does not belong to you');
    }
    if (message.role !== TutorMessageRole.TUTOR) {
      throw new ForbiddenException(
        'Only tutor messages have renderable content',
      );
    }
    return message;
  }

  // ─── GET /tutor/mastery ──────────────────────────────────────────────────

  async listMastery(
    userId: string,
    subjectId?: string,
    classLevel?: ClassLevel,
  ) {
    return this.prisma.studentMastery.findMany({
      where: { userId, subjectId, classLevel },
      include: { topic: { select: { theme: true, topic: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ─── GET /tutor/continue-learning ───────────────────────────────────────

  private static readonly LESSON_STATE_ORDER: LessonState[] = [
    'INTRODUCTION',
    'ASSESS_PRIOR_KNOWLEDGE',
    'EXPLAIN_CONCEPT',
    'EXAMPLE',
    'CHECK_UNDERSTANDING',
    'MINI_QUIZ',
    'COMPLETED',
  ];

  /**
   * Topics the student has started but not finished - one entry per topic
   * (the most recently active session, for students who started a topic
   * more than once), most recently active first. Backs the dashboard's
   * "Continue Learning" list, which should only ever show in-progress
   * work, never the full curriculum.
   */
  async listInProgressTopics(userId: string, subjectId?: string) {
    const sessions = await this.prisma.tutorSession.findMany({
      where: { userId, completedAt: null, ...(subjectId ? { subjectId } : {}) },
      include: {
        topic: {
          select: { id: true, subjectId: true, classLevel: true, theme: true, topic: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const seenTopicIds = new Set<string>();
    const result: {
      sessionId: string;
      state: LessonState;
      progressPercent: number;
      updatedAt: Date;
      topic: { id: string; subjectId: string; classLevel: ClassLevel; theme: string; topic: string };
    }[] = [];

    for (const session of sessions) {
      if (seenTopicIds.has(session.topicId)) continue;
      seenTopicIds.add(session.topicId);
      const stateIndex = TutorService.LESSON_STATE_ORDER.indexOf(session.state);
      result.push({
        sessionId: session.id,
        state: session.state,
        progressPercent: Math.round(
          (Math.max(stateIndex, 0) / (TutorService.LESSON_STATE_ORDER.length - 1)) * 100,
        ),
        updatedAt: session.updatedAt,
        topic: session.topic,
      });
    }
    return result;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async _getOwnedSession(userId: string, sessionId: string) {
    const session = await this.prisma.tutorSession.findUnique({
      where: { id: sessionId },
      include: { topic: { include: { subject: true } } },
    });
    if (!session) throw new NotFoundException('Tutor session not found');
    if (session.userId !== userId) {
      throw new ForbiddenException('This tutor session does not belong to you');
    }
    return session;
  }

  private async _getOrCreateMastery(
    userId: string,
    topicId: string,
    subjectId: string,
    classLevel: ClassLevel,
  ) {
    const existing = await this.prisma.studentMastery.findUnique({
      where: { userId_topicId: { userId, topicId } },
    });
    if (existing) return existing;

    return this.prisma.studentMastery.create({
      data: {
        userId,
        topicId,
        subjectId,
        classLevel,
        masteryScore: 0,
        weakAreas: [],
      },
    });
  }

  private async _applyMasteryFeedback(masteryId: string, turn: TutorTurn) {
    const mastery = await this.prisma.studentMastery.findUnique({
      where: { id: masteryId },
    });
    if (!mastery) return;

    const currentWeakAreas = new Set(
      (mastery.weakAreas as string[] | null) ?? [],
    );
    for (const tag of turn.weakAreaTags) currentWeakAreas.add(tag);
    // Cap the list so it doesn't grow unbounded across many sessions.
    const weakAreas = Array.from(currentWeakAreas).slice(-10);

    const masteryScore = Math.min(
      100,
      Math.max(0, mastery.masteryScore + turn.masteryDelta),
    );

    await this.prisma.studentMastery.update({
      where: { id: masteryId },
      data: { masteryScore, weakAreas, lastStudiedAt: new Date() },
    });
  }

  private async _recentHistory(
    sessionId: string,
  ): Promise<TutorHistoryEntry[]> {
    const messages = await this.prisma.tutorMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });
    return messages
      .reverse()
      .map((m) => ({ role: m.role, content: m.content }));
  }

  private async _persistTutorTurn(
    sessionId: string,
    stateAt: LessonState,
    turn: TutorTurn,
  ) {
    return this.prisma.tutorMessage.create({
      data: {
        sessionId,
        role: TutorMessageRole.TUTOR,
        content: blocksToText(turn.blocks),
        blocks: turn.blocks,
        stateAt,
      },
    });
  }

  private _topicContext(
    topic: {
      theme: string;
      topic: string;
      learningOutcome: string;
      focalCompetence: string;
      performanceObjectives: unknown;
      content: unknown;
      evaluationGuide: unknown;
    },
    subjectName: string,
    classLevel: ClassLevel,
  ) {
    return {
      subjectName,
      classLevel,
      theme: topic.theme,
      topic: topic.topic,
      learningOutcome: topic.learningOutcome,
      focalCompetence: topic.focalCompetence,
      performanceObjectives: topic.performanceObjectives as string[],
      knowledge: (topic.content as { knowledge?: unknown[] })?.knowledge ?? [],
      evaluationGuide: topic.evaluationGuide as string[],
    };
  }
}
