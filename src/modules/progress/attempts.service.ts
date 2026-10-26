import { Injectable } from '@nestjs/common';
import { AttemptSource } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface AttemptInput {
  questionId: string;
  /** Null when the question was left unanswered. */
  selectedOptionId: string | null;
  correct: boolean;
}

export interface TopicStat {
  subjectId: string;
  topic: string | null;
  attempts: number;
  correct: number;
  /** 0 to 1. */
  accuracy: number;
  lastAttemptAt: Date;
  /** 'thin' until there are enough answers to say anything (PRODUCT.md 10.2). */
  evidence: 'thin' | 'solid';
}

/** Answers needed on a topic before its accuracy counts as evidence. */
export const MIN_EVIDENCE_ATTEMPTS = 10;

@Injectable()
export class AttemptsService {
  constructor(private prisma: PrismaService) {}

  /** Records one graded answer per question for a session, challenge or exam.
   *  Idempotent per (user, source ref, question). */
  async record(userId: string, source: AttemptSource, sourceRefId: string, attempts: AttemptInput[]) {
    if (attempts.length === 0) return 0;
    const questions = await this.prisma.question.findMany({
      where: { id: { in: attempts.map((a) => a.questionId) } },
      select: { id: true, subjectId: true, topic: true },
    });
    const info = new Map(questions.map((q) => [q.id, q]));
    const res = await this.prisma.questionAttempt.createMany({
      data: attempts
        .filter((a) => info.has(a.questionId))
        .map((a) => ({
          userId,
          questionId: a.questionId,
          subjectId: info.get(a.questionId)!.subjectId,
          topic: info.get(a.questionId)!.topic,
          selectedOptionId: a.selectedOptionId,
          correct: a.correct,
          source,
          sourceRefId,
        })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /** Accuracy per subject and topic from the student's own answers. */
  async topicStats(userId: string, opts: { subjectId?: string } = {}): Promise<TopicStat[]> {
    const rows = await this.prisma.$queryRaw<
      { subjectId: string; topic: string | null; attempts: number; correct: number; last: Date }[]
    >`
      SELECT "subjectId", "topic",
             count(*)::int AS attempts,
             (count(*) FILTER (WHERE "correct"))::int AS correct,
             max("createdAt") AS last
        FROM "QuestionAttempt"
       WHERE "userId" = ${userId}
         AND (${opts.subjectId ?? null}::text IS NULL OR "subjectId" = ${opts.subjectId ?? null})
       GROUP BY "subjectId", "topic"
       ORDER BY max("createdAt") DESC`;
    return rows.map((r) => ({
      subjectId: r.subjectId,
      topic: r.topic,
      attempts: r.attempts,
      correct: r.correct,
      accuracy: r.attempts ? r.correct / r.attempts : 0,
      lastAttemptAt: r.last,
      evidence: r.attempts >= MIN_EVIDENCE_ATTEMPTS ? 'solid' : 'thin',
    }));
  }

  /** Topics worth revising: enough evidence and accuracy below `threshold`. */
  async weakTopics(userId: string, opts: { subjectId?: string; threshold?: number; limit?: number } = {}) {
    const threshold = opts.threshold ?? 0.6;
    return (await this.topicStats(userId, { subjectId: opts.subjectId }))
      .filter((t) => t.evidence === 'solid' && t.accuracy < threshold)
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, opts.limit ?? 5);
  }
}
