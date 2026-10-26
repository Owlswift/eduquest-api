import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ClassLevel, Prisma, QuizSessionStatus } from '@prisma/client';
import { lagosDate, lagosNextDayStart } from '../../common/time/lagos';
import { PrismaService } from '../../database/prisma.service';
import { QUIZ_SESSION_TTL_MS } from '../quiz/quiz.constants';
import { DAILY_MIN_QUESTIONS, DAILY_QUESTION_COUNT, DAILY_REWARDS } from './daily.constants';

export { DAILY_MIN_QUESTIONS, DAILY_QUESTION_COUNT, DAILY_REWARDS };

export type DailyState = 'AVAILABLE' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED' | 'UNAVAILABLE';

@Injectable()
export class DailyChallengesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Today's challenge for a class level, created on first request. Two
   * simultaneous first requests both try to insert; the unique (date, class
   * level) key lets exactly one win and both read the winner's questions, so
   * every student of a class level always gets the same set.
   */
  async getOrCreate(classLevel: ClassLevel, now: Date = new Date()) {
    const date = lagosDate(now);
    const existing = await this.prisma.dailyChallenge.findUnique({
      where: { date_classLevel: { date, classLevel } },
    });
    if (existing) return existing;

    const picked = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Question"
       WHERE "classLevel" = ${classLevel}::"ClassLevel" AND "status" = 'PUBLISHED'::"QuestionStatus"
       ORDER BY random() LIMIT ${DAILY_QUESTION_COUNT}`;
    if (picked.length < DAILY_MIN_QUESTIONS) return null;

    await this.prisma.dailyChallenge.createMany({
      data: [{ date, classLevel, questionIds: picked.map((p) => p.id) }],
      skipDuplicates: true,
    });
    return this.prisma.dailyChallenge.findUniqueOrThrow({
      where: { date_classLevel: { date, classLevel } },
    });
  }

  /** Where the student stands on today's challenge. */
  async status(userId: string, now: Date = new Date()) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { classLevel: true },
    });
    const challenge = await this.getOrCreate(user.classLevel, now);
    const resetsAt = lagosNextDayStart(now);
    if (!challenge) return { state: 'UNAVAILABLE' as DailyState, resetsAt, rewards: DAILY_REWARDS };

    const session = await this.prisma.quizSession.findUnique({
      where: { userId_dailyChallengeId: { userId, dailyChallengeId: challenge.id } },
    });
    let state: DailyState = 'AVAILABLE';
    if (session?.status === QuizSessionStatus.SUBMITTED) state = 'COMPLETED';
    else if (session) {
      state = now.getTime() - session.createdAt.getTime() > QUIZ_SESSION_TTL_MS ? 'EXPIRED' : 'IN_PROGRESS';
    }
    return {
      state,
      challengeId: challenge.id,
      date: challenge.date,
      classLevel: challenge.classLevel,
      questionCount: challenge.questionIds.length,
      resetsAt,
      rewards: DAILY_REWARDS,
      sessionId: state === 'IN_PROGRESS' ? session!.id : undefined,
      result:
        state === 'COMPLETED'
          ? { correct: session!.correctCount, total: challenge.questionIds.length }
          : undefined,
    };
  }

  /**
   * Starts (or resumes) the student's single attempt. The attempt is an
   * ordinary quiz session tied to the challenge, so answers are checked and
   * submitted through the same endpoints as any quiz.
   */
  async start(userId: string, now: Date = new Date()) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { classLevel: true },
    });
    const challenge = await this.getOrCreate(user.classLevel, now);
    if (!challenge) throw new NotFoundException('No daily challenge is available for your class yet');

    const where = { userId_dailyChallengeId: { userId, dailyChallengeId: challenge.id } };
    let session = await this.prisma.quizSession.findUnique({ where });
    if (!session) {
      try {
        session = await this.prisma.quizSession.create({
          data: {
            userId,
            dailyChallengeId: challenge.id,
            subjectId: 'daily',
            questionIds: challenge.questionIds,
          },
        });
      } catch (e) {
        // A double tap raced us: the other request created it.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          session = await this.prisma.quizSession.findUniqueOrThrow({ where });
        } else throw e;
      }
    }
    if (session.status === QuizSessionStatus.SUBMITTED) {
      throw new ConflictException('You already completed today’s challenge');
    }
    if (now.getTime() - session.createdAt.getTime() > QUIZ_SESSION_TTL_MS) {
      throw new ConflictException('Today’s challenge attempt has expired. A new one opens tomorrow');
    }

    const rows = await this.prisma.question.findMany({
      where: { id: { in: challenge.questionIds } },
      include: { options: true },
    });
    const byId = new Map(rows.map((q) => [q.id, q]));
    return challenge.questionIds
      .map((id) => byId.get(id))
      .filter((q): q is NonNullable<typeof q> => !!q)
      .map((q) => ({
        id: q.id,
        sessionId: session!.id,
        subjectId: q.subjectId,
        classLevel: q.classLevel,
        questionText: q.questionText,
        explanation: q.explanation,
        difficulty: q.difficulty,
        options: q.options.map((o) => ({ id: o.id, text: o.text })),
      }));
  }
}
