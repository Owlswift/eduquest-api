import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { GrantResult, LedgerService } from '../ledger/ledger.service';
import { AttemptSource, ClassLevel, LedgerCurrency, QuestionStatus, QuizSessionStatus } from '@prisma/client';
import { DAILY_REWARDS } from '../daily-challenges/daily.constants';
import { QUIZ_SESSION_TTL_MS } from './quiz.constants';
import { AchievementsService } from '../gamification/achievements.service';
import { levelProgress } from '../gamification/levels';
import { CompetitionSittingsService } from '../competitions/competition-sittings.service';
import { SITTING_GRACE_SEC } from '../competitions/competition-rules';
import { AttemptsService } from '../progress/attempts.service';

/** XP and coins paid per correct answer. */
export const QUIZ_XP_PER_CORRECT = 10;
export const QUIZ_COINS_PER_CORRECT = 10;
/** Most XP (and coins) the quiz can pay a student per (Lagos) day. A question
 *  also pays at most once per user per (Lagos) week, so replaying the same
 *  questions can't be farmed. */
export const QUIZ_DAILY_REWARD_CAP = 500;
export { QUIZ_SESSION_TTL_MS };

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no DST

export interface GradedSession {
  sessionId: string;
  subjectId: string;
  /** Set when the session was a daily-challenge attempt. */
  dailyChallengeId?: string | null;
  /** Set when the session was a sitting of a competition. */
  competitionId?: string | null;
  /** For a competition sitting: when it began, when it had to end, and what was answered. */
  startedAt?: Date;
  deadline?: Date;
  answeredCount?: number;
  answers?: Record<string, string>;
  /** Answered/correct counts per subject (a daily challenge mixes subjects). */
  bySubject?: { subjectId: string; answered: number; correct: number }[];
  /** Every question in the session, in issue order. */
  questionIds: string[];
  /** Subset of `questionIds` answered correctly. */
  correctIds: string[];
}

@Injectable()
export class QuizService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private ledger: LedgerService,
    private attempts: AttemptsService,
    private achievements: AchievementsService,
    private sittings: CompetitionSittingsService,
  ) {}

  // ─── GET /quiz/questions ────────────────────────────────────────────────────

  /** Issues a quiz session and returns its questions. Each question carries
   *  the `sessionId`; checking and submitting answers only works against a
   *  session the server issued, so the client can't choose what gets graded
   *  or rewarded. */
  async getRandomQuestions(
    userId: string,
    subjectId: string,
    count: number = 10,
    classLevel: ClassLevel = ClassLevel.SS1,
  ) {
    // Verify subject exists
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
    });
    if (!subject) throw new NotFoundException(`Subject ${subjectId} not found`);

    // Fetch all matching questions then randomise in JS
    // (avoids ORDER BY RANDOM() which is slow on large tables)
    const all = await this.prisma.question.findMany({
      where: { subjectId, classLevel, status: QuestionStatus.PUBLISHED },
      include: { options: true },
    });

    const limit = Math.min(Math.max(count, 1), 50);
    const shuffled = all.sort(() => Math.random() - 0.5).slice(0, limit);
    if (shuffled.length === 0) return [];

    const session = await this.prisma.quizSession.create({
      data: { userId, subjectId, questionIds: shuffled.map((q) => q.id) },
      select: { id: true },
    });

    // correctAnswerId is deliberately withheld - sending it would let a
    // client read the answer straight out of the network response.
    // Grading happens server-side in submitQuizResults instead.
    return shuffled.map((q) => ({
      id: q.id,
      sessionId: session.id,
      subjectId: q.subjectId,
      classLevel: q.classLevel,
      questionText: q.questionText,
      explanation: q.explanation,
      difficulty: q.difficulty,
      options: q.options.map((o) => ({ id: o.id, text: o.text })),
    }));
  }

  // ─── GET /quiz/topics ───────────────────────────────────────────────────────

  /** Distinct topics tagged on a subject's question bank, with how many
   *  questions exist for each - powers the Challenges topic picker.
   *  Subjects that predate topic tagging (or a subject that just hasn't
   *  been tagged yet) simply return an empty list. */
  async getTopics(subjectId: string, classLevel: ClassLevel = ClassLevel.SS1) {
    const rows = await this.prisma.question.groupBy({
      by: ['topic'],
      where: { subjectId, classLevel, topic: { not: null }, status: QuestionStatus.PUBLISHED },
      _count: { _all: true },
    });

    return rows
      .map((r) => ({ topic: r.topic as string, questionCount: r._count._all }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
  }

  // ─── POST /quiz/questions/:id/check ──────────────────────────────────────────

  /** Locks in the student's answer to one question of their session and
   *  reveals whether it was right. The first answer wins: it is stored
   *  atomically, and any later call for the same question just replays the
   *  stored answer's result - so the correct option can never be learned
   *  without committing to an answer first, and can't be retried. */
  async checkAnswer(
    userId: string,
    sessionId: string,
    questionId: string,
    selectedOptionId: string,
  ) {
    const session = await this._openSession(userId, sessionId);
    if (!session.questionIds.includes(questionId)) {
      throw new BadRequestException('Question is not part of this quiz session');
    }
    const deadline = session.competitionId ? await this._competitionDeadline(session) : null;
    if (deadline && Date.now() > deadline.getTime()) {
      throw new BadRequestException('Time is up for this competition');
    }

    // Conditional write: only succeeds while this question is unanswered.
    await this.prisma.$executeRaw`
      UPDATE "QuizSession"
         SET "answers" = "answers" || jsonb_build_object(${questionId}::text, ${selectedOptionId}::text)
       WHERE "id" = ${sessionId}
         AND "userId" = ${userId}
         AND "status" = 'OPEN'::"QuizSessionStatus"
         AND ("answers" ->> ${questionId}) IS NULL`;

    const fresh = await this.prisma.quizSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { answers: true },
    });
    const locked = (fresh.answers as Record<string, string>)[questionId] ?? selectedOptionId;

    // In a competition every entrant sits the same questions, so telling one
    // student the answer would let them pass it on. Only the lock is confirmed;
    // the answers are shown after the competition closes.
    if (session.competitionId) return { locked: true as const };

    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: { correctAnswerId: true, explanation: true },
    });
    if (!question) throw new NotFoundException('Question not found');

    return {
      correct: question.correctAnswerId === locked,
      correctOptionId: question.correctAnswerId,
      explanation: question.explanation,
    };
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  /** Grades a session exactly once. The OPEN -> SUBMITTED flip is a single
   *  conditional UPDATE, so concurrent or repeated submissions of the same
   *  session lose the race and are rejected. Answers locked in through
   *  [checkAnswer] take precedence over the submitted ones. */
  async gradeAndCloseSession(
    userId: string,
    sessionId: string,
    submitted: { questionId: string; selectedOptionId: string }[],
    source: AttemptSource = AttemptSource.QUIZ,
  ): Promise<GradedSession> {
    const session = await this._openSession(userId, sessionId);
    if (session.dailyChallengeId) source = AttemptSource.DAILY;
    if (session.competitionId) source = AttemptSource.COMPETITION;
    const now = new Date();
    const deadline = session.competitionId ? await this._competitionDeadline(session) : undefined;
    // Past the deadline (plus a little for network lag) only answers locked
    // in time count; whatever the client sends now is ignored.
    const bodyAllowed = !deadline || now.getTime() <= deadline.getTime() + SITTING_GRACE_SEC * 1000;

    const closed = await this.prisma.quizSession.updateMany({
      where: { id: sessionId, userId, status: QuizSessionStatus.OPEN },
      data: { status: QuizSessionStatus.SUBMITTED, submittedAt: new Date() },
    });
    if (closed.count === 0) {
      throw new BadRequestException('This quiz was already submitted');
    }

    const locked = session.answers as Record<string, string>;
    const sent = new Map((bodyAllowed ? submitted : []).map((a) => [a.questionId, a.selectedOptionId]));

    const questions = await this.prisma.question.findMany({
      where: { id: { in: session.questionIds } },
      select: { id: true, correctAnswerId: true, subjectId: true },
    });
    const correctById = new Map(questions.map((q) => [q.id, q.correctAnswerId]));
    const subjectOf = new Map(questions.map((q) => [q.id, q.subjectId]));

    const correctIds = session.questionIds.filter((id) => {
      const chosen = locked[id] ?? sent.get(id);
      return chosen !== undefined && correctById.get(id) === chosen;
    });

    // History for analytics, and the session's own score for achievements.
    const correctSet = new Set(correctIds);
    await Promise.all([
      this.prisma.quizSession.update({ where: { id: sessionId }, data: { correctCount: correctIds.length } }),
      this.attempts.record(
        userId,
        source,
        sessionId,
        session.questionIds.map((id) => {
          const chosen = locked[id] ?? sent.get(id);
          return { questionId: id, selectedOptionId: chosen ? chosen : null, correct: correctSet.has(id) };
        }),
      ),
    ]);

    const tally = new Map<string, { subjectId: string; answered: number; correct: number }>();
    for (const id of session.questionIds) {
      const subjectId = subjectOf.get(id) ?? session.subjectId;
      const row = tally.get(subjectId) ?? { subjectId, answered: 0, correct: 0 };
      row.answered += 1;
      if (correctSet.has(id)) row.correct += 1;
      tally.set(subjectId, row);
    }

    const chosenAll: Record<string, string> = {};
    for (const id of session.questionIds) {
      const chosen = locked[id] ?? sent.get(id);
      if (chosen) chosenAll[id] = chosen;
    }

    return {
      sessionId,
      subjectId: session.subjectId,
      dailyChallengeId: session.dailyChallengeId,
      competitionId: session.competitionId,
      startedAt: session.createdAt,
      deadline,
      answeredCount: Object.keys(chosenAll).length,
      answers: chosenAll,
      bySubject: [...tally.values()],
      questionIds: session.questionIds,
      correctIds,
    };
  }

  /** Pays a daily challenge's fixed bonus once: a completion bonus, plus a
   *  perfect-score bonus. Separate ledger keys make each idempotent. */
  async rewardDailyChallenge(userId: string, graded: GradedSession) {
    const challengeId = graded.dailyChallengeId!;
    const perfect = graded.correctIds.length === graded.questionIds.length && graded.questionIds.length > 0;
    const grants: GrantResult[] = [];
    await this.prisma.$transaction(async (tx) => {
      grants.push(
        await this.ledger.grant(
          { userId, xp: DAILY_REWARDS.completionXp, coins: DAILY_REWARDS.completionCoins, reason: 'daily_challenge', key: `daily:${userId}:${challengeId}:done`, refType: 'daily_challenge', refId: challengeId },
          tx,
        ),
      );
      if (perfect) {
        grants.push(
          await this.ledger.grant(
            { userId, xp: DAILY_REWARDS.perfectXp, coins: DAILY_REWARDS.perfectCoins, reason: 'daily_challenge', key: `daily:${userId}:${challengeId}:perfect`, refType: 'daily_challenge', refId: challengeId },
            tx,
          ),
        );
      }
    });
    const levelUp = LedgerService.mergeLevelUps(grants);
    if (levelUp) this.ledger.announceLevelUp(userId, levelUp);
    return {
      earnedXp: grants.reduce((n, g) => n + g.xp, 0),
      earnedCoins: grants.reduce((n, g) => n + g.coins, 0),
      levelUp,
      perfect,
    };
  }

  /** Pays XP + coins for the correct answers of a graded session, skipping
   *  questions already rewarded this week and respecting the daily cap.
   *  Returns what was actually paid. */
  async rewardQuizCorrects(userId: string, graded: GradedSession) {
    const now = new Date();
    const weekKey = this._lagosWeekKey(now);
    const paidToday = await this.ledger.sumSince(
      userId,
      LedgerCurrency.XP,
      'quiz',
      this._lagosDayStart(now),
    );
    let roomXp = Math.max(0, QUIZ_DAILY_REWARD_CAP - paidToday);

    let earnedXp = 0;
    let earnedCoins = 0;
    const results: GrantResult[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const questionId of graded.correctIds) {
        if (roomXp < QUIZ_XP_PER_CORRECT) break;
        const res = await this.ledger.grant(
          {
            userId,
            xp: QUIZ_XP_PER_CORRECT,
            coins: QUIZ_COINS_PER_CORRECT,
            reason: 'quiz',
            key: `quiz:${userId}:${questionId}:${weekKey}`,
            refType: 'question',
            refId: questionId,
          },
          tx,
        );
        results.push(res);
        if (res.applied) {
          earnedXp += res.xp;
          earnedCoins += res.coins;
          roomXp -= res.xp;
        }
      }
    });
    const levelUp = LedgerService.mergeLevelUps(results);
    if (levelUp) this.ledger.announceLevelUp(userId, levelUp);
    return { earnedXp, earnedCoins, levelUp };
  }

  private async _openSession(userId: string, sessionId: string) {
    const session = await this.prisma.quizSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('Quiz session not found');
    if (session.status !== QuizSessionStatus.OPEN) {
      throw new BadRequestException('This quiz was already submitted');
    }
    // A competition sitting is timed by its own deadline, and a late
    // submission is still graded (from the answers locked in time).
    if (!session.competitionId && Date.now() - session.createdAt.getTime() > QUIZ_SESSION_TTL_MS) {
      throw new BadRequestException('This quiz session has expired');
    }
    return session;
  }

  /** When a competition sitting must end: its own limit or the competition's end, whichever is first. */
  private async _competitionDeadline(session: { competitionId: string | null; expiresAt: Date | null; createdAt: Date }) {
    const c = await this.prisma.competition.findUniqueOrThrow({
      where: { id: session.competitionId! },
      select: { endsAt: true },
    });
    const own = session.expiresAt ?? c.endsAt;
    return own < c.endsAt ? own : c.endsAt;
  }

  /** Instant at which the current Lagos calendar day began. */
  private _lagosDayStart(now: Date): Date {
    const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
    return new Date(
      Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) - LAGOS_OFFSET_MS,
    );
  }

  /** `YYYY-MM-DD` of the Monday starting the current Lagos week. */
  private _lagosWeekKey(now: Date): string {
    const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
    const sinceMonday = (lagos.getUTCDay() + 6) % 7;
    const monday = new Date(
      Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate() - sinceMonday),
    );
    return monday.toISOString().slice(0, 10);
  }

  /** Grades a competition sitting that was never submitted (the student left,
   *  or time ran out) from the answers they locked in before the deadline. Used
   *  when a competition is validated and finalised. */
  async settleCompetitionSession(userId: string, sessionId: string) {
    const graded = await this.gradeAndCloseSession(userId, sessionId, []);
    if (!graded.competitionId) throw new BadRequestException('Not a competition session');
    return this.sittings.record({
      userId,
      competitionId: graded.competitionId,
      startedAt: graded.startedAt!,
      deadline: graded.deadline!,
      total: graded.questionIds.length,
      correct: graded.correctIds.length,
      answered: graded.answeredCount ?? 0,
      answers: graded.answers ?? {},
    });
  }

  // ─── POST /quiz/submit ──────────────────────────────────────────────────────

  async submitQuizResults(
    userId: string,
    dto: {
      sessionId: string;
      answers: { questionId: string; selectedOptionId: string }[];
      timeTaken: number;
    },
  ) {
    // Grade server-side against the session the server issued: the client
    // supplies only the session id and its picks, never the question list
    // or a score.
    const graded = await this.gradeAndCloseSession(userId, dto.sessionId, dto.answers);
    const totalQuestions = graded.questionIds.length;
    const correctAnswers = graded.correctIds.length;

    const isDaily = !!graded.dailyChallengeId;
    let dailyPerfect = false;
    let earnedXp: number;
    let earnedCoins: number;
    let competition: Awaited<ReturnType<CompetitionSittingsService['record']>> | undefined;
    if (graded.competitionId) {
      // A competition's score is its own: no per-question quiz rewards, just
      // the sitting's result and the competition's fixed participation reward.
      competition = await this.sittings.record({
        userId,
        competitionId: graded.competitionId,
        startedAt: graded.startedAt!,
        deadline: graded.deadline!,
        total: totalQuestions,
        correct: correctAnswers,
        answered: graded.answeredCount ?? 0,
        answers: graded.answers ?? {},
      });
      earnedXp = competition.participation.xp;
      earnedCoins = competition.participation.coins;
    } else if (isDaily) {
      const paid = await this.rewardDailyChallenge(userId, graded);
      ({ earnedXp, earnedCoins } = paid);
      dailyPerfect = paid.perfect;
    } else {
      ({ earnedXp, earnedCoins } = await this.rewardQuizCorrects(userId, graded));
    }

    // Subject-specific accuracy, for Challenge matchmaking - separate from
    // the global rolling `accuracy` below, since a student can be strong in
    // one subject and weak in another. Counted per question's own subject
    // (a daily challenge mixes subjects).
    for (const row of graded.bySubject ?? [{ subjectId: graded.subjectId, answered: totalQuestions, correct: correctAnswers }]) {
      await this.prisma.subjectStat.upsert({
        where: { userId_subjectId: { userId, subjectId: row.subjectId } },
        create: { userId, subjectId: row.subjectId, questionsAnswered: row.answered, correctAnswers: row.correct },
        update: {
          questionsAnswered: { increment: row.answered },
          correctAnswers: { increment: row.correct },
          lastActiveAt: new Date(),
        },
      });
    }

    // Update user stats atomically
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        questionsAnswered: { increment: totalQuestions },
        // Recalculate accuracy as rolling average
        accuracy: {
          set: await this._newAccuracy(userId, correctAnswers, totalQuestions),
        },
      },
      select: { id: true, coins: true, xp: true, questionsAnswered: true, state: true },
    });

    // Count these toward today's study activity / streak, and today's XP
    // toward the weekly/monthly leaderboard windows.
    await this.activity.recordQuestions(userId, totalQuestions);
    await this.activity.recordXp(userId, earnedXp);

    // Real ranks by XP - stateRank is null (not fabricated) if the
    // student hasn't set a state, since there's nothing real to compare.
    const [aheadNationally, aheadInState] = await Promise.all([
      this.prisma.user.count({ where: { role: 'STUDENT', xp: { gt: user.xp } } }),
      user.state
        ? this.prisma.user.count({
            where: { role: 'STUDENT', state: user.state, xp: { gt: user.xp } },
          })
        : Promise.resolve(null),
    ]);
    const nationalRank = aheadNationally + 1;
    const stateRank = aheadInState === null ? null : aheadInState + 1;

    // Streak, answer counts and this quiz's score are all in now: see what it unlocked.
    const unlocked = await this.achievements.evaluate(userId);
    const fresh = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { coins: true, xp: true },
    });

    return {
      earnedCoins,
      earnedXp,
      questionsAnsweredInChallenge: totalQuestions,
      correctAnswers,
      nationalRank,
      stateRank,
      totalCoins: fresh.coins,
      totalXp: fresh.xp,
      level: levelProgress(fresh.xp),
      daily: isDaily ? { completed: true, perfect: dailyPerfect } : undefined,
      competition: competition
        ? { id: graded.competitionId, score: competition.score, correct: competition.correct, wrong: competition.wrong, timeTakenSec: competition.timeTakenSec, rank: competition.rank }
        : undefined,
      newAchievements: unlocked.map((a) => ({ key: a.key, name: a.name, description: a.description, icon: a.icon })),
    };
  }

  // ─── Seed questions ─────────────────────────────────────────────────────────

  async seedQuestions() {
    const data = _seedData();
    let created = 0;
    let updated = 0;

    // Ensure required subjects exist before seeding questions
    const requiredSubjectIds = [...new Set(data.map((q) => q.subjectId))];
    for (const subjectId of requiredSubjectIds) {
      await this.prisma.subject.upsert({
        where: { id: subjectId },
        update: {},
        create: { id: subjectId, name: subjectId, icon: 'school_rounded', color: '#FF000000' },
      });
    }

    for (const q of data) {
      const exists = await this.prisma.question.findUnique({ where: { id: q.id } });

      if (exists) {
        // Re-running seed also re-tags existing rows (e.g. adding `topic`
        // to questions seeded before that field existed) - options aren't
        // touched here since none of the seed data changes them.
        await this.prisma.question.update({
          where: { id: q.id },
          data: {
            subjectId: q.subjectId,
            classLevel: q.classLevel as ClassLevel,
            topic: q.topic ?? null,
            questionText: q.questionText,
            explanation: q.explanation,
            difficulty: q.difficulty,
            correctAnswerId: q.correctAnswerId,
          },
        });
        updated++;
        continue;
      }

      await this.prisma.question.create({
        data: {
          id: q.id,
          subjectId: q.subjectId,
          classLevel: q.classLevel as ClassLevel,
          topic: q.topic ?? null,
          questionText: q.questionText,
          explanation: q.explanation,
          difficulty: q.difficulty,
          correctAnswerId: q.correctAnswerId,
          options: {
            create: q.options.map((o) => ({ id: o.id, text: o.text })),
          },
        },
      });
      created++;
    }

    return { message: 'Questions seeded', created, updated };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async _newAccuracy(
    userId: string,
    newCorrect: number,
    newTotal: number,
  ): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { accuracy: true, questionsAnswered: true },
    });
    if (!user) return newTotal > 0 ? newCorrect / newTotal : 0;

    const prevTotal = user.questionsAnswered;
    const prevCorrect = Math.round(user.accuracy * prevTotal);
    const total = prevTotal + newTotal;
    return total > 0 ? (prevCorrect + newCorrect) / total : 0;
  }
}

// ─── Seed data ────────────────────────────────────────────────────────────────

function _seedData() {
  return [
    // ── Mathematics — Algebra ────────────────────────────────────────────────
    {
      id: 'math_ss1_q1', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Algebra',
      questionText: 'What is the value of x in the equation: 2x + 5 = 13?',
      correctAnswerId: 'math_ss1_q1_b',
      explanation: '2x = 13 - 5 = 8, so x = 4',
      options: [
        { id: 'math_ss1_q1_a', text: '3' },
        { id: 'math_ss1_q1_b', text: '4' },
        { id: 'math_ss1_q1_c', text: '5' },
        { id: 'math_ss1_q1_d', text: '6' },
      ],
    },
    {
      id: 'math_ss1_q2', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Algebra',
      questionText: 'Which of the following is a prime number?',
      correctAnswerId: 'math_ss1_q2_b',
      explanation: '17 is only divisible by 1 and itself',
      options: [
        { id: 'math_ss1_q2_a', text: '15' },
        { id: 'math_ss1_q2_b', text: '17' },
        { id: 'math_ss1_q2_c', text: '21' },
        { id: 'math_ss1_q2_d', text: '25' },
      ],
    },
    {
      id: 'math_ss1_q3', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Algebra',
      questionText: 'What is √144?',
      correctAnswerId: 'math_ss1_q3_c',
      explanation: '12 × 12 = 144',
      options: [
        { id: 'math_ss1_q3_a', text: '10' },
        { id: 'math_ss1_q3_b', text: '11' },
        { id: 'math_ss1_q3_c', text: '12' },
        { id: 'math_ss1_q3_d', text: '13' },
      ],
    },
    {
      id: 'math_ss1_q4', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Algebra',
      questionText: 'Solve: 3(x − 2) = 15',
      correctAnswerId: 'math_ss1_q4_c',
      explanation: 'x − 2 = 5, so x = 7',
      options: [
        { id: 'math_ss1_q4_a', text: '5' },
        { id: 'math_ss1_q4_b', text: '6' },
        { id: 'math_ss1_q4_c', text: '7' },
        { id: 'math_ss1_q4_d', text: '8' },
      ],
    },
    {
      id: 'math_ss1_q5', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Algebra',
      questionText: 'What is 15% of 200?',
      correctAnswerId: 'math_ss1_q5_b',
      explanation: '0.15 × 200 = 30',
      options: [
        { id: 'math_ss1_q5_a', text: '25' },
        { id: 'math_ss1_q5_b', text: '30' },
        { id: 'math_ss1_q5_c', text: '35' },
        { id: 'math_ss1_q5_d', text: '40' },
      ],
    },
    {
      id: 'math_ss1_q6', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Algebra',
      questionText: 'If y = 2x + 3, what is y when x = 4?',
      correctAnswerId: 'math_ss1_q6_d',
      explanation: 'y = 2(4) + 3 = 11',
      options: [
        { id: 'math_ss1_q6_a', text: '8' },
        { id: 'math_ss1_q6_b', text: '9' },
        { id: 'math_ss1_q6_c', text: '10' },
        { id: 'math_ss1_q6_d', text: '11' },
      ],
    },
    {
      id: 'math_ss1_q8', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Algebra',
      questionText: 'Simplify: 4x + 3x − 2x',
      correctAnswerId: 'math_ss1_q8_b',
      explanation: '(4 + 3 − 2)x = 5x',
      options: [
        { id: 'math_ss1_q8_a', text: '3x' },
        { id: 'math_ss1_q8_b', text: '5x' },
        { id: 'math_ss1_q8_c', text: '7x' },
        { id: 'math_ss1_q8_d', text: '9x' },
      ],
    },
    {
      id: 'math_ss1_q9', subjectId: 'math', classLevel: 'SS1', difficulty: 3, topic: 'Algebra',
      questionText: 'Next in sequence: 2, 6, 18, 54, …?',
      correctAnswerId: 'math_ss1_q9_c',
      explanation: 'Each term × 3: 54 × 3 = 162',
      options: [
        { id: 'math_ss1_q9_a', text: '108' },
        { id: 'math_ss1_q9_b', text: '144' },
        { id: 'math_ss1_q9_c', text: '162' },
        { id: 'math_ss1_q9_d', text: '216' },
      ],
    },
    {
      id: 'math_ss1_q10', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Algebra',
      questionText: 'If a = 3 and b = 4, what is a² + b²?',
      correctAnswerId: 'math_ss1_q10_c',
      explanation: '9 + 16 = 25',
      options: [
        { id: 'math_ss1_q10_a', text: '12' },
        { id: 'math_ss1_q10_b', text: '14' },
        { id: 'math_ss1_q10_c', text: '25' },
        { id: 'math_ss1_q10_d', text: '49' },
      ],
    },
    {
      id: 'math_ss1_q11', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Algebra',
      questionText: 'What is 25% of 80?',
      correctAnswerId: 'math_ss1_q11_b',
      explanation: '0.25 × 80 = 20',
      options: [
        { id: 'math_ss1_q11_a', text: '15' },
        { id: 'math_ss1_q11_b', text: '20' },
        { id: 'math_ss1_q11_c', text: '25' },
        { id: 'math_ss1_q11_d', text: '30' },
      ],
    },
    {
      id: 'math_ss1_q12', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Algebra',
      questionText: 'Solve for x: 5x − 3 = 2x + 9',
      correctAnswerId: 'math_ss1_q12_c',
      explanation: '3x = 12, x = 4',
      options: [
        { id: 'math_ss1_q12_a', text: '2' },
        { id: 'math_ss1_q12_b', text: '3' },
        { id: 'math_ss1_q12_c', text: '4' },
        { id: 'math_ss1_q12_d', text: '5' },
      ],
    },

    // ── Mathematics — Quadratic Equations ───────────────────────────────────
    {
      id: 'math_quad_q1', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Quadratic Equations',
      questionText: 'Solve: x² − 5x + 6 = 0',
      correctAnswerId: 'math_quad_q1_a',
      explanation: '(x − 2)(x − 3) = 0, so x = 2 or x = 3',
      options: [
        { id: 'math_quad_q1_a', text: 'x = 2 or x = 3' },
        { id: 'math_quad_q1_b', text: 'x = 1 or x = 6' },
        { id: 'math_quad_q1_c', text: 'x = −2 or x = −3' },
        { id: 'math_quad_q1_d', text: 'x = 2 or x = −3' },
      ],
    },
    {
      id: 'math_quad_q2', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Quadratic Equations',
      questionText: 'Solve: x² − 9 = 0',
      correctAnswerId: 'math_quad_q2_b',
      explanation: 'x² = 9, so x = 3 or x = −3',
      options: [
        { id: 'math_quad_q2_a', text: 'x = 9 or x = −9' },
        { id: 'math_quad_q2_b', text: 'x = 3 or x = −3' },
        { id: 'math_quad_q2_c', text: 'x = 3 only' },
        { id: 'math_quad_q2_d', text: 'No solution' },
      ],
    },
    {
      id: 'math_quad_q3', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Quadratic Equations',
      questionText: 'Solve: x² + 4x = 0',
      correctAnswerId: 'math_quad_q3_c',
      explanation: 'x(x + 4) = 0, so x = 0 or x = −4',
      options: [
        { id: 'math_quad_q3_a', text: 'x = 0 or x = 4' },
        { id: 'math_quad_q3_b', text: 'x = 4 only' },
        { id: 'math_quad_q3_c', text: 'x = 0 or x = −4' },
        { id: 'math_quad_q3_d', text: 'No solution' },
      ],
    },
    {
      id: 'math_quad_q4', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Quadratic Equations',
      questionText: 'What is the quadratic formula for ax² + bx + c = 0?',
      correctAnswerId: 'math_quad_q4_a',
      explanation: 'x = (−b ± √(b² − 4ac)) / 2a',
      options: [
        { id: 'math_quad_q4_a', text: 'x = (−b ± √(b² − 4ac)) / 2a' },
        { id: 'math_quad_q4_b', text: 'x = (−b ± √(b² − 4ac)) / a' },
        { id: 'math_quad_q4_c', text: 'x = (b ± √(b² − 4ac)) / 2a' },
        { id: 'math_quad_q4_d', text: 'x = (−b ± √(b² + 4ac)) / 2a' },
      ],
    },
    {
      id: 'math_quad_q5', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Quadratic Equations',
      questionText: 'Solve: x² − 7x + 12 = 0',
      correctAnswerId: 'math_quad_q5_b',
      explanation: '(x − 3)(x − 4) = 0, so x = 3 or x = 4',
      options: [
        { id: 'math_quad_q5_a', text: 'x = 3 or x = 5' },
        { id: 'math_quad_q5_b', text: 'x = 3 or x = 4' },
        { id: 'math_quad_q5_c', text: 'x = −3 or x = −4' },
        { id: 'math_quad_q5_d', text: 'x = 12 or x = 1' },
      ],
    },
    {
      id: 'math_quad_q6', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Quadratic Equations',
      questionText: 'If x² = 49, what is x?',
      correctAnswerId: 'math_quad_q6_a',
      explanation: 'x = 7 or x = −7',
      options: [
        { id: 'math_quad_q6_a', text: 'x = 7 or x = −7' },
        { id: 'math_quad_q6_b', text: 'x = 7 only' },
        { id: 'math_quad_q6_c', text: 'x = 24.5' },
        { id: 'math_quad_q6_d', text: 'x = 14' },
      ],
    },
    {
      id: 'math_quad_q7', subjectId: 'math', classLevel: 'SS1', difficulty: 3, topic: 'Quadratic Equations',
      questionText: 'Solve: x² − x − 6 = 0',
      correctAnswerId: 'math_quad_q7_d',
      explanation: '(x − 3)(x + 2) = 0, so x = 3 or x = −2',
      options: [
        { id: 'math_quad_q7_a', text: 'x = 2 or x = −3' },
        { id: 'math_quad_q7_b', text: 'x = 6 or x = 1' },
        { id: 'math_quad_q7_c', text: 'x = −3 or x = −2' },
        { id: 'math_quad_q7_d', text: 'x = 3 or x = −2' },
      ],
    },
    {
      id: 'math_quad_q8', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Quadratic Equations',
      questionText: 'Solve: 2x² − 8 = 0',
      correctAnswerId: 'math_quad_q8_b',
      explanation: 'x² = 4, so x = 2 or x = −2',
      options: [
        { id: 'math_quad_q8_a', text: 'x = 4 or x = −4' },
        { id: 'math_quad_q8_b', text: 'x = 2 or x = −2' },
        { id: 'math_quad_q8_c', text: 'x = 8 or x = −8' },
        { id: 'math_quad_q8_d', text: 'x = 16' },
      ],
    },

    // ── Mathematics — Geometry ───────────────────────────────────────────────
    {
      id: 'math_geo_q1', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Geometry',
      questionText: 'Area of a rectangle with length 8cm and width 5cm?',
      correctAnswerId: 'math_geo_q1_c',
      explanation: 'Area = 8 × 5 = 40 cm²',
      options: [
        { id: 'math_geo_q1_a', text: '26 cm²' },
        { id: 'math_geo_q1_b', text: '36 cm²' },
        { id: 'math_geo_q1_c', text: '40 cm²' },
        { id: 'math_geo_q1_d', text: '48 cm²' },
      ],
    },
    {
      id: 'math_geo_q2', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Geometry',
      questionText: 'What is the perimeter of a square with side 6cm?',
      correctAnswerId: 'math_geo_q2_c',
      explanation: 'Perimeter = 4 × 6 = 24cm',
      options: [
        { id: 'math_geo_q2_a', text: '12 cm' },
        { id: 'math_geo_q2_b', text: '18 cm' },
        { id: 'math_geo_q2_c', text: '24 cm' },
        { id: 'math_geo_q2_d', text: '36 cm' },
      ],
    },
    {
      id: 'math_geo_q3', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Geometry',
      questionText: 'What is the sum of the interior angles of a triangle?',
      correctAnswerId: 'math_geo_q3_b',
      explanation: 'Always 180°',
      options: [
        { id: 'math_geo_q3_a', text: '90°' },
        { id: 'math_geo_q3_b', text: '180°' },
        { id: 'math_geo_q3_c', text: '270°' },
        { id: 'math_geo_q3_d', text: '360°' },
      ],
    },
    {
      id: 'math_geo_q4', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Geometry',
      questionText: 'A circle has radius 7cm. Find its circumference (π = 22/7).',
      correctAnswerId: 'math_geo_q4_b',
      explanation: 'C = 2 × 22/7 × 7 = 44cm',
      options: [
        { id: 'math_geo_q4_a', text: '22 cm' },
        { id: 'math_geo_q4_b', text: '44 cm' },
        { id: 'math_geo_q4_c', text: '154 cm' },
        { id: 'math_geo_q4_d', text: '88 cm' },
      ],
    },
    {
      id: 'math_geo_q5', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Geometry',
      questionText: 'Find the area of a triangle with base 10cm and height 6cm.',
      correctAnswerId: 'math_geo_q5_a',
      explanation: 'Area = ½ × 10 × 6 = 30 cm²',
      options: [
        { id: 'math_geo_q5_a', text: '30 cm²' },
        { id: 'math_geo_q5_b', text: '60 cm²' },
        { id: 'math_geo_q5_c', text: '16 cm²' },
        { id: 'math_geo_q5_d', text: '36 cm²' },
      ],
    },
    {
      id: 'math_geo_q6', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Geometry',
      questionText: 'How many sides does a hexagon have?',
      correctAnswerId: 'math_geo_q6_c',
      explanation: 'A hexagon has 6 sides',
      options: [
        { id: 'math_geo_q6_a', text: '5' },
        { id: 'math_geo_q6_b', text: '7' },
        { id: 'math_geo_q6_c', text: '6' },
        { id: 'math_geo_q6_d', text: '8' },
      ],
    },
    {
      id: 'math_geo_q7', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Geometry',
      questionText: 'What is the sum of the interior angles of a quadrilateral?',
      correctAnswerId: 'math_geo_q7_d',
      explanation: 'Always 360°',
      options: [
        { id: 'math_geo_q7_a', text: '90°' },
        { id: 'math_geo_q7_b', text: '180°' },
        { id: 'math_geo_q7_c', text: '270°' },
        { id: 'math_geo_q7_d', text: '360°' },
      ],
    },
    {
      id: 'math_geo_q8', subjectId: 'math', classLevel: 'SS1', difficulty: 3, topic: 'Geometry',
      questionText: 'A circle has radius 14cm. Find its area (π = 22/7).',
      correctAnswerId: 'math_geo_q8_c',
      explanation: 'Area = 22/7 × 14² = 616 cm²',
      options: [
        { id: 'math_geo_q8_a', text: '44 cm²' },
        { id: 'math_geo_q8_b', text: '308 cm²' },
        { id: 'math_geo_q8_c', text: '616 cm²' },
        { id: 'math_geo_q8_d', text: '196 cm²' },
      ],
    },

    // ── Mathematics — Trigonometry ───────────────────────────────────────────
    {
      id: 'math_trig_q1', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Trigonometry',
      questionText: 'In a right-angled triangle, sine (sin θ) is defined as:',
      correctAnswerId: 'math_trig_q1_a',
      explanation: 'sin θ = Opposite / Hypotenuse',
      options: [
        { id: 'math_trig_q1_a', text: 'Opposite / Hypotenuse' },
        { id: 'math_trig_q1_b', text: 'Adjacent / Hypotenuse' },
        { id: 'math_trig_q1_c', text: 'Opposite / Adjacent' },
        { id: 'math_trig_q1_d', text: 'Hypotenuse / Opposite' },
      ],
    },
    {
      id: 'math_trig_q2', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Trigonometry',
      questionText: 'What is sin 30°?',
      correctAnswerId: 'math_trig_q2_b',
      explanation: 'sin 30° = 0.5',
      options: [
        { id: 'math_trig_q2_a', text: '0' },
        { id: 'math_trig_q2_b', text: '0.5' },
        { id: 'math_trig_q2_c', text: '1' },
        { id: 'math_trig_q2_d', text: '0.87' },
      ],
    },
    {
      id: 'math_trig_q3', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Trigonometry',
      questionText: 'What is cos 60°?',
      correctAnswerId: 'math_trig_q3_b',
      explanation: 'cos 60° = 0.5',
      options: [
        { id: 'math_trig_q3_a', text: '0' },
        { id: 'math_trig_q3_b', text: '0.5' },
        { id: 'math_trig_q3_c', text: '1' },
        { id: 'math_trig_q3_d', text: '0.87' },
      ],
    },
    {
      id: 'math_trig_q4', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Trigonometry',
      questionText: 'What is tan 45°?',
      correctAnswerId: 'math_trig_q4_c',
      explanation: 'tan 45° = 1',
      options: [
        { id: 'math_trig_q4_a', text: '0' },
        { id: 'math_trig_q4_b', text: '0.5' },
        { id: 'math_trig_q4_c', text: '1' },
        { id: 'math_trig_q4_d', text: '2' },
      ],
    },
    {
      id: 'math_trig_q5', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Trigonometry',
      questionText: 'In a right triangle, the opposite side = 3 and the hypotenuse = 5. What is sin θ?',
      correctAnswerId: 'math_trig_q5_b',
      explanation: 'sin θ = 3/5 = 0.6',
      options: [
        { id: 'math_trig_q5_a', text: '0.5' },
        { id: 'math_trig_q5_b', text: '0.6' },
        { id: 'math_trig_q5_c', text: '0.75' },
        { id: 'math_trig_q5_d', text: '1.67' },
      ],
    },
    {
      id: 'math_trig_q6', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Trigonometry',
      questionText: 'What is cos 0°?',
      correctAnswerId: 'math_trig_q6_c',
      explanation: 'cos 0° = 1',
      options: [
        { id: 'math_trig_q6_a', text: '0' },
        { id: 'math_trig_q6_b', text: '0.5' },
        { id: 'math_trig_q6_c', text: '1' },
        { id: 'math_trig_q6_d', text: '−1' },
      ],
    },
    {
      id: 'math_trig_q7', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Trigonometry',
      questionText: 'What is sin 90°?',
      correctAnswerId: 'math_trig_q7_c',
      explanation: 'sin 90° = 1',
      options: [
        { id: 'math_trig_q7_a', text: '0' },
        { id: 'math_trig_q7_b', text: '0.5' },
        { id: 'math_trig_q7_c', text: '1' },
        { id: 'math_trig_q7_d', text: '0.87' },
      ],
    },
    {
      id: 'math_trig_q8', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Trigonometry',
      questionText: 'In a right triangle, the adjacent side = 4 and the hypotenuse = 5. What is cos θ?',
      correctAnswerId: 'math_trig_q8_c',
      explanation: 'cos θ = 4/5 = 0.8',
      options: [
        { id: 'math_trig_q8_a', text: '0.6' },
        { id: 'math_trig_q8_b', text: '0.75' },
        { id: 'math_trig_q8_c', text: '0.8' },
        { id: 'math_trig_q8_d', text: '1.25' },
      ],
    },

    // ── Mathematics — Probability ────────────────────────────────────────────
    {
      id: 'math_prob_q1', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Probability',
      questionText: 'A fair coin is tossed once. What is the probability of getting a head?',
      correctAnswerId: 'math_prob_q1_b',
      explanation: '1 favourable outcome out of 2 possible: 1/2',
      options: [
        { id: 'math_prob_q1_a', text: '1/4' },
        { id: 'math_prob_q1_b', text: '1/2' },
        { id: 'math_prob_q1_c', text: '1' },
        { id: 'math_prob_q1_d', text: '0' },
      ],
    },
    {
      id: 'math_prob_q2', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Probability',
      questionText: 'A die is rolled once. What is the probability of getting a 4?',
      correctAnswerId: 'math_prob_q2_c',
      explanation: '1 favourable outcome out of 6: 1/6',
      options: [
        { id: 'math_prob_q2_a', text: '1/2' },
        { id: 'math_prob_q2_b', text: '1/3' },
        { id: 'math_prob_q2_c', text: '1/6' },
        { id: 'math_prob_q2_d', text: '1/4' },
      ],
    },
    {
      id: 'math_prob_q3', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Probability',
      questionText: 'A bag contains 3 red and 2 blue balls. What is the probability of picking a red ball?',
      correctAnswerId: 'math_prob_q3_a',
      explanation: '3 red out of 5 total: 3/5',
      options: [
        { id: 'math_prob_q3_a', text: '3/5' },
        { id: 'math_prob_q3_b', text: '2/5' },
        { id: 'math_prob_q3_c', text: '3/2' },
        { id: 'math_prob_q3_d', text: '1/5' },
      ],
    },
    {
      id: 'math_prob_q4', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Probability',
      questionText: 'A die is rolled once. What is the probability of getting an even number?',
      correctAnswerId: 'math_prob_q4_b',
      explanation: '3 even numbers (2,4,6) out of 6: 1/2',
      options: [
        { id: 'math_prob_q4_a', text: '1/3' },
        { id: 'math_prob_q4_b', text: '1/2' },
        { id: 'math_prob_q4_c', text: '2/3' },
        { id: 'math_prob_q4_d', text: '1/6' },
      ],
    },
    {
      id: 'math_prob_q5', subjectId: 'math', classLevel: 'SS1', difficulty: 3, topic: 'Probability',
      questionText: 'A card is drawn from a standard deck of 52. What is the probability it is a King?',
      correctAnswerId: 'math_prob_q5_c',
      explanation: '4 Kings out of 52 cards: 4/52 = 1/13',
      options: [
        { id: 'math_prob_q5_a', text: '1/4' },
        { id: 'math_prob_q5_b', text: '1/52' },
        { id: 'math_prob_q5_c', text: '1/13' },
        { id: 'math_prob_q5_d', text: '4/13' },
      ],
    },
    {
      id: 'math_prob_q6', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Probability',
      questionText: 'Two fair coins are tossed. What is the probability of getting two heads?',
      correctAnswerId: 'math_prob_q6_c',
      explanation: 'Only 1 of 4 outcomes (HH, HT, TH, TT) is two heads: 1/4',
      options: [
        { id: 'math_prob_q6_a', text: '1/2' },
        { id: 'math_prob_q6_b', text: '1/3' },
        { id: 'math_prob_q6_c', text: '1/4' },
        { id: 'math_prob_q6_d', text: '2/4' },
      ],
    },
    {
      id: 'math_prob_q7', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Probability',
      questionText: 'A bag has 5 red, 3 blue and 2 green balls. What is the probability of picking blue?',
      correctAnswerId: 'math_prob_q7_b',
      explanation: '3 blue out of 10 total: 3/10',
      options: [
        { id: 'math_prob_q7_a', text: '1/5' },
        { id: 'math_prob_q7_b', text: '3/10' },
        { id: 'math_prob_q7_c', text: '1/2' },
        { id: 'math_prob_q7_d', text: '3/5' },
      ],
    },
    {
      id: 'math_prob_q8', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Probability',
      questionText: 'What is the probability of an impossible event?',
      correctAnswerId: 'math_prob_q8_a',
      explanation: 'An impossible event has probability 0',
      options: [
        { id: 'math_prob_q8_a', text: '0' },
        { id: 'math_prob_q8_b', text: '1' },
        { id: 'math_prob_q8_c', text: '0.5' },
        { id: 'math_prob_q8_d', text: 'Undefined' },
      ],
    },

    // ── Mathematics — Statistics ─────────────────────────────────────────────
    {
      id: 'math_stat_q1', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Statistics',
      questionText: 'Find the mean of: 2, 4, 6, 8, 10',
      correctAnswerId: 'math_stat_q1_b',
      explanation: 'Sum = 30, 30 ÷ 5 = 6',
      options: [
        { id: 'math_stat_q1_a', text: '5' },
        { id: 'math_stat_q1_b', text: '6' },
        { id: 'math_stat_q1_c', text: '8' },
        { id: 'math_stat_q1_d', text: '30' },
      ],
    },
    {
      id: 'math_stat_q2', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Statistics',
      questionText: 'Find the median of: 3, 7, 9, 15, 20',
      correctAnswerId: 'math_stat_q2_c',
      explanation: 'The middle value of the ordered list is 9',
      options: [
        { id: 'math_stat_q2_a', text: '7' },
        { id: 'math_stat_q2_b', text: '15' },
        { id: 'math_stat_q2_c', text: '9' },
        { id: 'math_stat_q2_d', text: '10.8' },
      ],
    },
    {
      id: 'math_stat_q3', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Statistics',
      questionText: 'Find the mode of: 2, 3, 3, 5, 7, 3, 8',
      correctAnswerId: 'math_stat_q3_a',
      explanation: '3 appears most often (3 times)',
      options: [
        { id: 'math_stat_q3_a', text: '3' },
        { id: 'math_stat_q3_b', text: '5' },
        { id: 'math_stat_q3_c', text: '7' },
        { id: 'math_stat_q3_d', text: '8' },
      ],
    },
    {
      id: 'math_stat_q4', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Statistics',
      questionText: 'Find the range of: 4, 8, 15, 16, 23, 42',
      correctAnswerId: 'math_stat_q4_c',
      explanation: 'Range = highest − lowest = 42 − 4 = 38',
      options: [
        { id: 'math_stat_q4_a', text: '42' },
        { id: 'math_stat_q4_b', text: '18' },
        { id: 'math_stat_q4_c', text: '38' },
        { id: 'math_stat_q4_d', text: '23' },
      ],
    },
    {
      id: 'math_stat_q5', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Statistics',
      questionText: 'Find the mean of: 10, 20, 30',
      correctAnswerId: 'math_stat_q5_b',
      explanation: 'Sum = 60, 60 ÷ 3 = 20',
      options: [
        { id: 'math_stat_q5_a', text: '10' },
        { id: 'math_stat_q5_b', text: '20' },
        { id: 'math_stat_q5_c', text: '30' },
        { id: 'math_stat_q5_d', text: '60' },
      ],
    },
    {
      id: 'math_stat_q6', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Statistics',
      questionText: 'Find the median of: 2, 4, 6, 8',
      correctAnswerId: 'math_stat_q6_b',
      explanation: 'Even count - average the two middle values: (4 + 6) ÷ 2 = 5',
      options: [
        { id: 'math_stat_q6_a', text: '4' },
        { id: 'math_stat_q6_b', text: '5' },
        { id: 'math_stat_q6_c', text: '6' },
        { id: 'math_stat_q6_d', text: '20' },
      ],
    },
    {
      id: 'math_stat_q7', subjectId: 'math', classLevel: 'SS1', difficulty: 1, topic: 'Statistics',
      questionText: 'Find the mode of: 5, 5, 6, 7, 7, 7, 9',
      correctAnswerId: 'math_stat_q7_c',
      explanation: '7 appears most often (3 times)',
      options: [
        { id: 'math_stat_q7_a', text: '5' },
        { id: 'math_stat_q7_b', text: '6' },
        { id: 'math_stat_q7_c', text: '7' },
        { id: 'math_stat_q7_d', text: '9' },
      ],
    },
    {
      id: 'math_stat_q8', subjectId: 'math', classLevel: 'SS1', difficulty: 2, topic: 'Statistics',
      questionText: 'Find the range of: 12, 5, 18, 9, 21',
      correctAnswerId: 'math_stat_q8_b',
      explanation: 'Range = 21 − 5 = 16',
      options: [
        { id: 'math_stat_q8_a', text: '21' },
        { id: 'math_stat_q8_b', text: '16' },
        { id: 'math_stat_q8_c', text: '13' },
        { id: 'math_stat_q8_d', text: '9' },
      ],
    },
    // ── English ───────────────────────────────────────────────────────────────
    {
      id: 'english_ss1_q1', subjectId: 'english', classLevel: 'SS1', difficulty: 1, topic: 'Vocabulary',
      questionText: 'Choose the correct spelling:',
      correctAnswerId: 'english_ss1_q1_b',
      explanation: '"Necessary" is the correct spelling',
      options: [
        { id: 'english_ss1_q1_a', text: 'Nessecary' },
        { id: 'english_ss1_q1_b', text: 'Necessary' },
        { id: 'english_ss1_q1_c', text: 'Necesary' },
        { id: 'english_ss1_q1_d', text: 'Necessery' },
      ],
    },
    {
      id: 'english_ss1_q2', subjectId: 'english', classLevel: 'SS1', difficulty: 1, topic: 'Grammar',
      questionText: 'What is the plural of "child"?',
      correctAnswerId: 'english_ss1_q2_c',
      explanation: '"Children" is the irregular plural of "child"',
      options: [
        { id: 'english_ss1_q2_a', text: 'Childs' },
        { id: 'english_ss1_q2_b', text: 'Childes' },
        { id: 'english_ss1_q2_c', text: 'Children' },
        { id: 'english_ss1_q2_d', text: 'Childrens' },
      ],
    },
    {
      id: 'english_ss1_q3', subjectId: 'english', classLevel: 'SS1', difficulty: 2, topic: 'Grammar',
      questionText: 'Identify the verb in: "The dog barked loudly."',
      correctAnswerId: 'english_ss1_q3_b',
      explanation: '"Barked" is the action verb in this sentence',
      options: [
        { id: 'english_ss1_q3_a', text: 'dog' },
        { id: 'english_ss1_q3_b', text: 'barked' },
        { id: 'english_ss1_q3_c', text: 'loudly' },
        { id: 'english_ss1_q3_d', text: 'the' },
      ],
    },
    {
      id: 'english_ss1_q4', subjectId: 'english', classLevel: 'SS1', difficulty: 2, topic: 'Grammar',
      questionText: 'Which sentence is grammatically correct?',
      correctAnswerId: 'english_ss1_q4_a',
      explanation: 'Subject-verb agreement: "She" takes "is"',
      options: [
        { id: 'english_ss1_q4_a', text: 'She is going to school.' },
        { id: 'english_ss1_q4_b', text: 'She are going to school.' },
        { id: 'english_ss1_q4_c', text: 'She were going to school.' },
        { id: 'english_ss1_q4_d', text: 'She be going to school.' },
      ],
    },
    {
      id: 'english_ss1_q5', subjectId: 'english', classLevel: 'SS1', difficulty: 1, topic: 'Vocabulary',
      questionText: 'What is a synonym for "happy"?',
      correctAnswerId: 'english_ss1_q5_c',
      explanation: '"Joyful" means feeling or expressing great happiness',
      options: [
        { id: 'english_ss1_q5_a', text: 'Sad' },
        { id: 'english_ss1_q5_b', text: 'Angry' },
        { id: 'english_ss1_q5_c', text: 'Joyful' },
        { id: 'english_ss1_q5_d', text: 'Tired' },
      ],
    },
    {
      id: 'english_ss1_q6', subjectId: 'english', classLevel: 'SS1', difficulty: 2, topic: 'Vocabulary',
      questionText: 'The opposite of "ancient" is:',
      correctAnswerId: 'english_ss1_q6_b',
      explanation: '"Modern" means relating to present or recent times',
      options: [
        { id: 'english_ss1_q6_a', text: 'Old' },
        { id: 'english_ss1_q6_b', text: 'Modern' },
        { id: 'english_ss1_q6_c', text: 'Historical' },
        { id: 'english_ss1_q6_d', text: 'Antique' },
      ],
    },
    {
      id: 'english_ss1_q7', subjectId: 'english', classLevel: 'SS1', difficulty: 1, topic: 'Grammar',
      questionText: 'Which word is an adjective in: "The tall man walked slowly"?',
      correctAnswerId: 'english_ss1_q7_b',
      explanation: '"Tall" describes the noun "man" — it\'s an adjective',
      options: [
        { id: 'english_ss1_q7_a', text: 'walked' },
        { id: 'english_ss1_q7_b', text: 'tall' },
        { id: 'english_ss1_q7_c', text: 'slowly' },
        { id: 'english_ss1_q7_d', text: 'man' },
      ],
    },
    {
      id: 'english_ss1_q8', subjectId: 'english', classLevel: 'SS1', difficulty: 3, topic: 'Literature',
      questionText: 'Identify the figure of speech: "The wind whispered through the trees."',
      correctAnswerId: 'english_ss1_q8_a',
      explanation: 'Giving human qualities (whispering) to a non-human (wind) is personification',
      options: [
        { id: 'english_ss1_q8_a', text: 'Personification' },
        { id: 'english_ss1_q8_b', text: 'Simile' },
        { id: 'english_ss1_q8_c', text: 'Metaphor' },
        { id: 'english_ss1_q8_d', text: 'Hyperbole' },
      ],
    },
    {
      id: 'english_ss1_q9', subjectId: 'english', classLevel: 'SS1', difficulty: 2, topic: 'Grammar',
      questionText: '"She runs _____ than her brother." Fill in the blank:',
      correctAnswerId: 'english_ss1_q9_c',
      explanation: 'Comparative form of "fast" is "faster"',
      options: [
        { id: 'english_ss1_q9_a', text: 'fast' },
        { id: 'english_ss1_q9_b', text: 'fastest' },
        { id: 'english_ss1_q9_c', text: 'faster' },
        { id: 'english_ss1_q9_d', text: 'more fast' },
      ],
    },
    {
      id: 'english_ss1_q10', subjectId: 'english', classLevel: 'SS1', difficulty: 2, topic: 'Grammar',
      questionText: 'Which sentence uses the past tense correctly?',
      correctAnswerId: 'english_ss1_q10_b',
      explanation: '"Went" is the past tense of "go"',
      options: [
        { id: 'english_ss1_q10_a', text: 'She go to the market yesterday.' },
        { id: 'english_ss1_q10_b', text: 'She went to the market yesterday.' },
        { id: 'english_ss1_q10_c', text: 'She goes to the market yesterday.' },
        { id: 'english_ss1_q10_d', text: 'She going to the market yesterday.' },
      ],
    },
    // ── Physics ───────────────────────────────────────────────────────────────
    {
      id: 'physics_ss1_q1', subjectId: 'physics', classLevel: 'SS1', difficulty: 1, topic: 'Mechanics',
      questionText: 'What is the SI unit of force?',
      correctAnswerId: 'physics_ss1_q1_b',
      explanation: 'Force is measured in Newtons (N), named after Isaac Newton',
      options: [
        { id: 'physics_ss1_q1_a', text: 'Joule' },
        { id: 'physics_ss1_q1_b', text: 'Newton' },
        { id: 'physics_ss1_q1_c', text: 'Watt' },
        { id: 'physics_ss1_q1_d', text: 'Pascal' },
      ],
    },
    {
      id: 'physics_ss1_q2', subjectId: 'physics', classLevel: 'SS1', difficulty: 2, topic: 'Mechanics',
      questionText: 'A car travels 120km in 2 hours. What is its average speed?',
      correctAnswerId: 'physics_ss1_q2_c',
      explanation: 'Speed = Distance ÷ Time = 120 ÷ 2 = 60 km/h',
      options: [
        { id: 'physics_ss1_q2_a', text: '40 km/h' },
        { id: 'physics_ss1_q2_b', text: '50 km/h' },
        { id: 'physics_ss1_q2_c', text: '60 km/h' },
        { id: 'physics_ss1_q2_d', text: '70 km/h' },
      ],
    },
    {
      id: 'physics_ss1_q3', subjectId: 'physics', classLevel: 'SS1', difficulty: 1, topic: 'Mechanics',
      questionText: 'Which of these is NOT a vector quantity?',
      correctAnswerId: 'physics_ss1_q3_d',
      explanation: 'Speed has magnitude only (no direction), so it is a scalar, not a vector',
      options: [
        { id: 'physics_ss1_q3_a', text: 'Velocity' },
        { id: 'physics_ss1_q3_b', text: 'Force' },
        { id: 'physics_ss1_q3_c', text: 'Acceleration' },
        { id: 'physics_ss1_q3_d', text: 'Speed' },
      ],
    },
    {
      id: 'physics_ss1_q4', subjectId: 'physics', classLevel: 'SS1', difficulty: 2, topic: 'Mechanics',
      questionText: 'Newton\'s first law states that a body at rest will:',
      correctAnswerId: 'physics_ss1_q4_a',
      explanation: 'A body remains at rest unless acted upon by an external force (inertia)',
      options: [
        { id: 'physics_ss1_q4_a', text: 'Remain at rest unless a force acts on it' },
        { id: 'physics_ss1_q4_b', text: 'Accelerate continuously' },
        { id: 'physics_ss1_q4_c', text: 'Move in a circle' },
        { id: 'physics_ss1_q4_d', text: 'Gain mass over time' },
      ],
    },
    {
      id: 'physics_ss1_q5', subjectId: 'physics', classLevel: 'SS1', difficulty: 1, topic: 'Electricity',
      questionText: 'What is the unit of electrical current?',
      correctAnswerId: 'physics_ss1_q5_b',
      explanation: 'Electrical current is measured in Amperes (A)',
      options: [
        { id: 'physics_ss1_q5_a', text: 'Volt' },
        { id: 'physics_ss1_q5_b', text: 'Ampere' },
        { id: 'physics_ss1_q5_c', text: 'Ohm' },
        { id: 'physics_ss1_q5_d', text: 'Watt' },
      ],
    },
    {
      id: 'physics_ss1_q6', subjectId: 'physics', classLevel: 'SS1', difficulty: 2, topic: 'Pressure',
      questionText: 'What happens to pressure when depth in a liquid increases?',
      correctAnswerId: 'physics_ss1_q6_a',
      explanation: 'Pressure increases with depth: P = ρgh',
      options: [
        { id: 'physics_ss1_q6_a', text: 'Pressure increases' },
        { id: 'physics_ss1_q6_b', text: 'Pressure decreases' },
        { id: 'physics_ss1_q6_c', text: 'Pressure stays the same' },
        { id: 'physics_ss1_q6_d', text: 'Pressure becomes zero' },
      ],
    },
    {
      id: 'physics_ss1_q7', subjectId: 'physics', classLevel: 'SS1', difficulty: 1, topic: 'Energy',
      questionText: 'Which form of energy does a moving car possess?',
      correctAnswerId: 'physics_ss1_q7_b',
      explanation: 'A moving object has kinetic energy due to its motion',
      options: [
        { id: 'physics_ss1_q7_a', text: 'Potential energy' },
        { id: 'physics_ss1_q7_b', text: 'Kinetic energy' },
        { id: 'physics_ss1_q7_c', text: 'Chemical energy' },
        { id: 'physics_ss1_q7_d', text: 'Nuclear energy' },
      ],
    },
    {
      id: 'physics_ss1_q8', subjectId: 'physics', classLevel: 'SS1', difficulty: 2, topic: 'Waves',
      questionText: 'What is the relationship between frequency and wavelength?',
      correctAnswerId: 'physics_ss1_q8_c',
      explanation: 'As frequency increases, wavelength decreases (they are inversely proportional)',
      options: [
        { id: 'physics_ss1_q8_a', text: 'Directly proportional' },
        { id: 'physics_ss1_q8_b', text: 'No relationship' },
        { id: 'physics_ss1_q8_c', text: 'Inversely proportional' },
        { id: 'physics_ss1_q8_d', text: 'Exponential relationship' },
      ],
    },
    {
      id: 'physics_ss1_q9', subjectId: 'physics', classLevel: 'SS1', difficulty: 1, topic: 'Pressure',
      questionText: 'What instrument measures atmospheric pressure?',
      correctAnswerId: 'physics_ss1_q9_a',
      explanation: 'A barometer measures atmospheric pressure',
      options: [
        { id: 'physics_ss1_q9_a', text: 'Barometer' },
        { id: 'physics_ss1_q9_b', text: 'Thermometer' },
        { id: 'physics_ss1_q9_c', text: 'Manometer' },
        { id: 'physics_ss1_q9_d', text: 'Altimeter' },
      ],
    },
    {
      id: 'physics_ss1_q10', subjectId: 'physics', classLevel: 'SS1', difficulty: 3, topic: 'Energy',
      questionText: 'An object of mass 5kg is lifted 3m high. What is its potential energy? (g = 10 m/s²)',
      correctAnswerId: 'physics_ss1_q10_b',
      explanation: 'PE = mgh = 5 × 10 × 3 = 150 J',
      options: [
        { id: 'physics_ss1_q10_a', text: '50 J' },
        { id: 'physics_ss1_q10_b', text: '150 J' },
        { id: 'physics_ss1_q10_c', text: '300 J' },
        { id: 'physics_ss1_q10_d', text: '450 J' },
      ],
    },
  ];
}