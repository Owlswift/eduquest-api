import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { GrantResult, LedgerService } from '../ledger/ledger.service';
import { lagosDate } from '../../common/time/lagos';
import { answerFingerprint, effectiveStatus, leagueAward, quizCountsForLeague, scoreSitting, sittingFlags } from './competition-rules';

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

export interface LeaguePointsResult {
  competitionId: string;
  title: string;
  /** Points this quiz earned (0 once the daily maximum is reached). */
  pointsEarned: number;
  pointsToday: number;
  dailyPointsCap: number | null;
  totalPoints: number;
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

  /**
   * Scores a finished practice quiz for every points league the student has
   * joined that is running now. Each league applies its own amount and daily
   * maximum. A quiz session is counted at most once per league (unique
   * session), and the student's row for the day is locked while the maximum is
   * checked, so two quizzes finishing together cannot both squeeze under it.
   * Never throws into the quiz flow: a failure here only means no points.
   */
  async recordLeaguePoints(
    userId: string,
    quiz: { sessionId: string; questionCount: number; subjectIds: string[] },
    now: Date = new Date(),
  ): Promise<LeaguePointsResult[]> {
    const leagues = await this.prisma.competition.findMany({
      where: { format: 'POINTS_LEAGUE', status: { in: ['PUBLISHED', 'ACTIVE'] }, startsAt: { lte: now }, endsAt: { gte: now }, participants: { some: { userId, status: { in: ['ENTERED', 'COMPLETED'] } } } },
    });
    const day = lagosDate(now);
    const out: LeaguePointsResult[] = [];
    for (const c of leagues) {
      if (effectiveStatus(c, now) !== 'ACTIVE' || !quizCountsForLeague(c, { questionCount: quiz.questionCount, subjectIds: quiz.subjectIds })) continue;
      try {
        const r = await this.prisma.$transaction(async (tx) => {
          await tx.competitionDailyPoints.createMany({ data: [{ competitionId: c.id, userId, day }], skipDuplicates: true });
          // Lock the day's row: concurrent quizzes by this student queue here.
          const [row] = await tx.$queryRaw<{ points: number }[]>(Prisma.sql`
            SELECT "points" FROM "CompetitionDailyPoints" WHERE "competitionId" = ${c.id} AND "userId" = ${userId} AND "day" = ${day} FOR UPDATE`);
          const awarded = leagueAward(c, row.points);
          const counted = await tx.competitionPointsEntry.createMany({ data: [{ competitionId: c.id, userId, sessionId: quiz.sessionId, points: awarded, day }], skipDuplicates: true });
          if (counted.count === 0) return null; // this quiz was already scored
          if (awarded > 0) {
            await tx.competitionDailyPoints.updateMany({ where: { competitionId: c.id, userId, day }, data: { points: { increment: awarded } } });
            // `score` can be null before the first point, which Prisma's increment would leave null.
            await tx.$executeRaw`
              UPDATE "CompetitionParticipant"
                 SET "score" = COALESCE("score", 0) + ${awarded}, "completedAt" = ${now}, "status" = 'COMPLETED'::"EntryStatus"
               WHERE "competitionId" = ${c.id} AND "userId" = ${userId} AND "status" IN ('ENTERED'::"EntryStatus", 'COMPLETED'::"EntryStatus")`;
          }
          const mine = await tx.competitionParticipant.findUnique({ where: { competitionId_userId: { competitionId: c.id, userId } }, select: { score: true } });
          return { awarded, today: row.points + awarded, total: mine?.score ?? 0 };
        });
        if (r) out.push({ competitionId: c.id, title: c.title, pointsEarned: r.awarded, pointsToday: r.today, dailyPointsCap: c.dailyPointsCap, totalPoints: r.total });
      } catch {
        // Scoring a league must never break submitting a quiz.
      }
    }
    return out;
  }
}
