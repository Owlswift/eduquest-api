import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { GrantResult, LedgerService } from '../ledger/ledger.service';
import { answerFingerprint, scoreSitting, sittingFlags } from './competition-rules';

export interface SittingInput {
  userId: string;
  competitionId: string;
  /** When the student began (the session's creation time). */
  startedAt: Date;
  /** The moment the sitting must have ended by; later time is not counted. */
  deadline: Date;
  /** Questions in the sitting, how many were answered correctly, and how many answered at all. */
  total: number;
  correct: number;
  answered: number;
  /** The chosen option per question, for the answer-sheet fingerprint. */
  answers: Record<string, string>;
}

export interface SittingResult {
  score: number;
  correct: number;
  wrong: number;
  timeTakenSec: number;
  rank: number | null;
  participation: { xp: number; coins: number };
  levelUp?: { from: number; to: number };
  /** False when this sitting had already been recorded. */
  recorded: boolean;
}

/** Turns a graded competition session into the student's entry result. */
@Injectable()
export class CompetitionSittingsService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
  ) {}

  async record(input: SittingInput, now: Date = new Date()): Promise<SittingResult> {
    const c = await this.prisma.competition.findUniqueOrThrow({ where: { id: input.competitionId } });
    const wrong = Math.max(0, input.answered - input.correct);
    const score = scoreSitting(input.correct, wrong, c);
    // Time is counted up to the deadline, never beyond it.
    const end = now < input.deadline ? now : input.deadline;
    const timeTakenSec = Math.max(0, Math.round((end.getTime() - input.startedAt.getTime()) / 1000));
    const flags = sittingFlags(input.answered, timeTakenSec);

    // The status flip is the gate: only the first call for a student records and pays.
    const flipped = await this.prisma.competitionParticipant.updateMany({
      where: { competitionId: c.id, userId: input.userId, status: { in: ['ENTERED', 'IN_PROGRESS'] } },
      data: {
        status: 'COMPLETED',
        startedAt: input.startedAt,
        completedAt: end,
        score,
        correctCount: input.correct,
        wrongCount: wrong,
        timeTakenSec,
        flags,
        answerHash: answerFingerprint(input.answers),
      },
    });
    const recorded = flipped.count === 1;

    let participation = { xp: 0, coins: 0 };
    let levelUp: SittingResult['levelUp'];
    if (recorded && (c.participationXp > 0 || c.participationCoins > 0)) {
      const grant: GrantResult = await this.ledger.grant({
        userId: input.userId,
        xp: c.participationXp,
        coins: c.participationCoins,
        reason: 'competition_participation',
        key: `competition:${c.id}:${input.userId}:participation`,
        refType: 'competition',
        refId: c.id,
      });
      participation = { xp: grant.xp, coins: grant.coins };
      levelUp = grant.levelUp;
    }
    return { score, correct: input.correct, wrong, timeTakenSec, rank: await this.livePosition(c.id, input.userId), participation, levelUp, recorded };
  }

  /** The student's current position among completed entries (strict order, no shared places). */
  async livePosition(competitionId: string, userId: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ pos: number }[]>(Prisma.sql`
      SELECT pos::int AS pos FROM (
        SELECT "userId",
               ROW_NUMBER() OVER (ORDER BY "score" DESC, "timeTakenSec" ASC, "completedAt" ASC) AS pos
          FROM "CompetitionParticipant"
         WHERE "competitionId" = ${competitionId} AND "status" = 'COMPLETED'
      ) ranked WHERE "userId" = ${userId}`);
    return rows[0]?.pos ?? null;
  }
}
