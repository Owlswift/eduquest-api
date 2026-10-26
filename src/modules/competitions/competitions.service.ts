import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttemptSource, Prisma, QuizSessionStatus } from '@prisma/client';
import { lagosDate } from '../../common/time/lagos';
import { publicName } from '../../common/names';
import { PrismaService } from '../../database/prisma.service';
import { guardianConsentMissing } from '../../common/safeguarding';
import { publicSponsor, SPONSOR_SELECT } from '../sponsors/logo';
import { NotificationsService } from '../notifications/notifications.service';
import {
  checkEligibility, effectiveStatus, legacyStatus, LEAGUE_TIE_BREAK_TEXT, sittingDeadline, TIE_BREAK_TEXT,
} from './competition-rules';
import { CompetitionSittingsService } from './competition-sittings.service';

type CompetitionRow = Prisma.CompetitionGetPayload<{ include: { prizeList: true; sponsor: { select: typeof SPONSOR_SELECT }; _count: { select: { participants: true } } } }>;

/** How a student qualified for a stage, when they did. */
type Qualification = { fromRank: number; fromCompetition: { title: string } };

const WITH_PRIZES = { prizeList: { orderBy: { sortOrder: 'asc' } }, sponsor: { select: SPONSOR_SELECT }, _count: { select: { participants: true } } } as const;

/** Rows are not shown to students until published. */
const VISIBLE = { status: { not: 'DRAFT' } } as const;

@Injectable()
export class CompetitionsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private sittings: CompetitionSittingsService,
  ) {}

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Brings stored statuses in line with the clock (PUBLISHED -> ACTIVE -> CLOSED).
   *  Conditional on the old status, so concurrent readers can't fight. Mutates the rows. */
  private async sync(rows: { id: string; status: any; startsAt: Date; endsAt: Date }[], now = new Date()) {
    for (const r of rows) {
      const next = effectiveStatus(r, now);
      if (next === r.status) continue;
      await this.prisma.competition.updateMany({ where: { id: r.id, status: r.status }, data: { status: next } });
      r.status = next;
    }
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async list(userId: string) {
    const [rows, user, entries, quals] = await Promise.all([
      this.prisma.competition.findMany({ where: VISIBLE, orderBy: { startsAt: 'asc' }, include: WITH_PRIZES }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { classLevel: true, state: true, age: true, guardianConsentAt: true } }),
      this.prisma.competitionParticipant.findMany({ where: { userId } }),
      this.prisma.competitionQualification.findMany({ where: { userId }, select: { competitionId: true, fromRank: true, fromCompetition: { select: { title: true } } } }),
    ]);
    await this.sync(rows);
    const mine = new Map(entries.map((e) => [e.competitionId, e]));
    const qualified = new Map(quals.map((q) => [q.competitionId, q]));
    return rows.map((c) => this.summary(c, user, mine.get(c.id), qualified.get(c.id)));
  }

  /** Everything the student has entered, newest first, with how it ended. */
  async history(userId: string) {
    const entries = await this.prisma.competitionParticipant.findMany({
      where: { userId },
      orderBy: { joinedAt: 'desc' },
      include: { competition: { select: { id: true, title: true, type: true, format: true, status: true, startsAt: true, endsAt: true } } },
    });
    const ids = entries.map((e) => e.competitionId);
    const [awards, certs, totals] = await Promise.all([
      this.prisma.prizeAward.findMany({ where: { userId, competitionId: { in: ids } }, include: { prize: true } }),
      this.prisma.certificate.findMany({ where: { userId, competitionId: { in: ids } } }),
      this.prisma.competitionParticipant.groupBy({ by: ['competitionId'], where: { competitionId: { in: ids }, status: 'COMPLETED' }, _count: { _all: true } }),
    ]);
    const award = new Map(awards.map((a) => [a.competitionId, a]));
    const completed = new Map(totals.map((t) => [t.competitionId, t._count._all]));
    return entries.map((e) => ({
      competition: { id: e.competition.id, title: e.competition.title, type: e.competition.type, endsAt: e.competition.endsAt },
      lifecycle: effectiveStatus(e.competition),
      status: e.status,
      score: e.score,
      // Only final once the results are confirmed.
      rank: e.rank,
      outOf: completed.get(e.competitionId) ?? 0,
      disqualifiedReason: e.status === 'DISQUALIFIED' ? e.disqualifiedReason : null,
      prize: award.has(e.competitionId)
        ? { id: award.get(e.competitionId)!.id, title: award.get(e.competitionId)!.prize.title, status: award.get(e.competitionId)!.status }
        : null,
      certificates: certs.filter((c) => c.competitionId === e.competitionId).map((c) => ({ id: c.id, kind: c.kind, title: c.title, verificationCode: c.verificationCode })),
    }));
  }

  async detail(userId: string, id: string) {
    const c = await this.load(id);
    const [user, entry, completed, qual] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { classLevel: true, state: true, age: true, guardianConsentAt: true } }),
      this.prisma.competitionParticipant.findUnique({ where: { competitionId_userId: { competitionId: id, userId } } }),
      this.prisma.competitionParticipant.count({ where: { competitionId: id, status: 'COMPLETED' } }),
      this.qualificationOf(userId, id),
    ]);
    const session = entry ? await this.prisma.quizSession.findUnique({ where: { userId_competitionId: { userId, competitionId: id } } }) : null;
    const league = c.format === 'POINTS_LEAGUE';
    const today = league && entry
      ? ((await this.prisma.competitionDailyPoints.findUnique({ where: { competitionId_userId_day: { competitionId: id, userId, day: lagosDate() } } }))?.points ?? 0)
      : 0;
    return {
      ...this.summary(c, user, entry ?? undefined, qual ?? undefined),
      description: c.description,
      completedCount: completed,
      scoring: league
        ? {
            questionCount: null,
            pointsPerCorrect: null,
            penaltyPerWrong: null,
            timeLimitSec: null,
            pointsPerQuiz: c.pointsPerQuiz,
            dailyPointsCap: c.dailyPointsCap,
            minQuestionsPerQuiz: c.minQuestionsPerQuiz,
            tieBreak: LEAGUE_TIE_BREAK_TEXT,
            revealsAnswers: null,
          }
        : {
            questionCount: c.questionCount,
            pointsPerCorrect: c.pointsPerCorrect,
            penaltyPerWrong: c.penaltyPerWrong,
            timeLimitSec: c.timeLimitSec,
            tieBreak: TIE_BREAK_TEXT,
            revealsAnswers: 'Correct answers are shown after the competition closes.',
          },
      league: league ? { pointsPerQuiz: c.pointsPerQuiz, dailyPointsCap: c.dailyPointsCap, minQuestionsPerQuiz: c.minQuestionsPerQuiz, pointsToday: today, pointsLeftToday: c.dailyPointsCap == null ? null : Math.max(0, c.dailyPointsCap - today) } : null,
      participation: { xp: c.participationXp, coins: c.participationCoins },
      claimDeadlineDays: c.claimDeadlineDays,
      subjectIds: c.subjectIds,
      prizeList: c.prizeList.map((p) => ({ positionFrom: p.positionFrom, positionTo: p.positionTo, title: p.title, kind: p.kind })),
      myEntry: entry
        ? {
            status: entry.status,
            score: entry.score,
            correctCount: entry.correctCount,
            timeTakenSec: entry.timeTakenSec,
            rank: entry.rank,
            // Where the student's sitting must end, so the app can show a countdown.
            sittingEndsAt: session?.status === QuizSessionStatus.OPEN ? session.expiresAt : null,
            sessionId: session?.status === QuizSessionStatus.OPEN ? session.id : null,
          }
        : null,
    };
  }

  private summary(
    c: CompetitionRow,
    user: { classLevel: any; state: string | null; age?: string | null; guardianConsentAt?: Date | null },
    entry?: { status: string; score: number | null; rank: number | null },
    qualification?: Qualification,
  ) {
    const elig = checkEligibility(c, user, !!qualification, c.prizeList.length > 0 && guardianConsentMissing(user));
    const titles = c.prizeList.length > 0 ? c.prizeList.map((p) => p.title) : ((c.prizes as string[]) ?? []);
    return {
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      prizes: titles,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      // Older clients: upcoming / ongoing / ended.
      status: legacyStatus(c),
      participantCount: c._count.participants,
      isJoined: !!entry,
      // The full lifecycle and the rest of what a student needs to decide.
      lifecycle: c.status,
      // "Sponsored by": show the logo (the name is for its alt text).
      sponsor: publicSponsor(c.sponsor),
      type: c.type,
      format: c.format,
      classLevels: c.classLevels,
      region: c.region,
      state: c.state,
      timeLimitSec: c.timeLimitSec,
      questionCount: c.questionCount,
      // Points leagues: what a quiz is worth and the most a student can earn in a day.
      pointsPerQuiz: c.pointsPerQuiz,
      dailyPointsCap: c.dailyPointsCap,
      eligible: elig.eligible,
      ineligibleReason: elig.reason ?? null,
      // Stages: a final may be open only to those who qualified for it.
      requiresQualification: c.requiresQualification,
      qualification: qualification ? { fromRank: qualification.fromRank, fromCompetition: qualification.fromCompetition.title } : null,
      myStatus: entry?.status ?? null,
      myScore: entry?.score ?? null,
      myRank: entry?.rank ?? null,
    };
  }

  private async load(id: string): Promise<CompetitionRow> {
    const c = await this.prisma.competition.findFirst({ where: { id, ...VISIBLE }, include: WITH_PRIZES });
    if (!c) throw new NotFoundException('Competition not found');
    await this.sync([c]);
    return c;
  }

  // ─── Joining and sitting ────────────────────────────────────────────────────

  /** Idempotent. Entries close when the competition does. */
  async join(userId: string, id: string) {
    const c = await this.load(id);
    if (!['PUBLISHED', 'ACTIVE'].includes(c.status)) throw new BadRequestException('This competition has already ended');
    await this.assertEligible(userId, c);

    const existing = await this.prisma.competitionParticipant.findUnique({ where: { competitionId_userId: { competitionId: id, userId } }, select: { id: true } });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { xp: true } });
    // INSERT .. ON CONFLICT DO NOTHING: two taps at once both succeed and make one entry.
    await this.prisma.competitionParticipant.createMany({
      data: [{ competitionId: id, userId, xpAtJoin: user?.xp ?? 0 }],
      skipDuplicates: true,
    });
    if (!existing) {
      await this.notifications.notify(userId, 'competition_joined', 'Competition joined', `You joined ${c.title}. Good luck.`, { competitionId: id });
    }
    return { joined: true };
  }

  /**
   * Begins the student's single sitting of a fixed-set competition (or resumes
   * it). Joins them first if they have not. Questions come back in their own
   * order, options shuffled, with no answers and no feedback: correctness is
   * only revealed after the competition closes.
   */
  async start(userId: string, id: string) {
    const c = await this.load(id);
    if (c.format === 'POINTS_LEAGUE') throw new BadRequestException('This is a points league: there is nothing to start. Practise quizzes while you are entered and they earn points');
    if (c.format !== 'FIXED_SET') throw new BadRequestException('This competition is ranked by XP earned, not by a sitting');
    if (c.status === 'PUBLISHED') throw new BadRequestException(`This competition opens ${c.startsAt.toISOString()}`);
    if (c.status !== 'ACTIVE') throw new BadRequestException('This competition has closed');
    await this.assertEligible(userId, c);

    const now = new Date();
    const where = { userId_competitionId: { userId, competitionId: id } };
    let session = await this.prisma.quizSession.findUnique({ where });
    if (!session) {
      await this.prisma.competitionParticipant.createMany({ data: [{ competitionId: id, userId }], skipDuplicates: true });
      try {
        session = await this.prisma.quizSession.create({
          data: {
            userId,
            competitionId: id,
            subjectId: c.subjectIds.length === 1 ? c.subjectIds[0] : 'competition',
            questionIds: shuffle(c.questionIds),
            expiresAt: sittingDeadline(now, c.timeLimitSec, c.endsAt),
          },
        });
      } catch (e) {
        // A double tap raced us: the other request created it.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') session = await this.prisma.quizSession.findUniqueOrThrow({ where });
        else throw e;
      }
      await this.prisma.competitionParticipant.updateMany({
        where: { competitionId: id, userId, status: 'ENTERED' },
        data: { status: 'IN_PROGRESS', startedAt: session.createdAt },
      });
    }
    if (session.status !== QuizSessionStatus.OPEN) throw new ConflictException('You have already taken this competition');
    const deadline = sittingDeadline(session.createdAt, c.timeLimitSec, c.endsAt);
    if (now > deadline) throw new ConflictException('Your time for this competition is up');

    const rows = await this.prisma.question.findMany({ where: { id: { in: session.questionIds } }, include: { options: true } });
    const byId = new Map(rows.map((q) => [q.id, q]));
    return {
      competitionId: c.id,
      title: c.title,
      sessionId: session.id,
      startedAt: session.createdAt,
      endsAt: deadline,
      remainingSec: Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 1000)),
      questions: session.questionIds
        .map((qid) => byId.get(qid))
        .filter((q): q is NonNullable<typeof q> => !!q)
        .map((q) => ({
          id: q.id,
          sessionId: session!.id,
          subjectId: q.subjectId,
          classLevel: q.classLevel,
          questionText: q.questionText,
          difficulty: q.difficulty,
          // No explanation: it would give the answer away.
          options: shuffle(q.options.map((o) => ({ id: o.id, text: o.text }))),
        })),
    };
  }

  private async assertEligible(userId: string, c: CompetitionRow) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { classLevel: true, state: true, age: true, guardianConsentAt: true } });
    const qualified = c.requiresQualification ? !!(await this.qualificationOf(userId, c.id)) : false;
    const elig = checkEligibility(c, user, qualified, c.prizeList.length > 0 && guardianConsentMissing(user));
    if (!elig.eligible) throw new ForbiddenException(elig.reason);
  }

  private qualificationOf(userId: string, competitionId: string) {
    return this.prisma.competitionQualification.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
      select: { fromRank: true, fromCompetition: { select: { title: true } } },
    });
  }

  // ─── Rankings ───────────────────────────────────────────────────────────────

  async leaderboard(userId: string, id: string, limit = 20) {
    const c = await this.load(id);
    if (c.format === 'POINTS_LEAGUE') return this.leagueLeaderboard(userId, c, limit);
    return c.format === 'FIXED_SET' ? this.sittingLeaderboard(userId, c, limit) : this.xpWindowLeaderboard(userId, c, limit);
  }

  /** Total points, best first; level totals go to whoever reached them first. Entrants who have not scored are not ranked. */
  private async leagueLeaderboard(userId: string, c: CompetitionRow, limit: number) {
    const rows = await this.prisma.$queryRaw<{ userId: string; fullName: string; state: string | null; score: number; pos: number }[]>(Prisma.sql`
      SELECT p."userId", u."fullName", u."state", p."score",
             (ROW_NUMBER() OVER (ORDER BY p."score" DESC, p."completedAt" ASC))::int AS pos
        FROM "CompetitionParticipant" p JOIN "User" u ON u."id" = p."userId"
       WHERE p."competitionId" = ${c.id} AND p."status" = 'COMPLETED' AND p."score" > 0`);
    const view = (r: (typeof rows)[number]) => ({ rank: r.pos, name: publicName(r.fullName), state: r.state, points: r.score, isMe: r.userId === userId });
    return {
      format: 'POINTS_LEAGUE' as const,
      title: c.title,
      metric: 'Points',
      tieBreak: LEAGUE_TIE_BREAK_TEXT,
      lifecycle: c.status,
      final: c.status === 'FINALISED' || c.status === 'ARCHIVED',
      entered: c._count.participants,
      scored: rows.length,
      top: rows.slice(0, limit).map(view),
      me: rows.find((r) => r.userId === userId) ? view(rows.find((r) => r.userId === userId)!) : null,
    };
  }

  /** One query ranks every completed entry (no per-student lookups). */
  private async sittingLeaderboard(userId: string, c: CompetitionRow, limit: number) {
    const rows = await this.prisma.$queryRaw<
      { userId: string; fullName: string; state: string | null; score: number; correct: number; time: number; pos: number }[]
    >(Prisma.sql`
      SELECT p."userId", u."fullName", u."state", p."score", p."correctCount" AS correct, p."timeTakenSec" AS time,
             (ROW_NUMBER() OVER (ORDER BY p."score" DESC, p."timeTakenSec" ASC, p."completedAt" ASC))::int AS pos
        FROM "CompetitionParticipant" p JOIN "User" u ON u."id" = p."userId"
       WHERE p."competitionId" = ${c.id} AND p."status" = 'COMPLETED'
       ORDER BY pos`);
    const view = (r: (typeof rows)[number]) => ({
      rank: r.pos,
      name: publicName(r.fullName),
      state: r.state,
      score: r.score,
      xpEarned: r.score, // older clients read this name
      correctCount: r.correct,
      timeTakenSec: r.time,
      isMe: r.userId === userId,
    });
    const mine = rows.find((r) => r.userId === userId);
    const entered = c._count.participants;
    return {
      format: 'FIXED_SET' as const,
      title: c.title,
      metric: 'Competition score',
      tieBreak: TIE_BREAK_TEXT,
      lifecycle: c.status,
      // Until results are finalised an admin may still disqualify an entry.
      final: c.status === 'FINALISED' || c.status === 'ARCHIVED',
      entered,
      completed: rows.length,
      top: rows.slice(0, limit).map(view),
      me: mine ? view(mine) : null,
    };
  }

  /**
   * Original format: XP earned between joining (or the start) and now (or the
   * end), summed in ONE query. The window is counted in whole UTC days, as it
   * always was, because daily activity is stored per day.
   */
  private async xpWindowLeaderboard(userId: string, c: CompetitionRow, limit: number) {
    const now = new Date();
    const windowEnd = now < c.endsAt ? now : c.endsAt;
    const rows = await this.prisma.$queryRaw<{ userId: string; fullName: string; xp: number }[]>(Prisma.sql`
      SELECT p."userId", u."fullName", COALESCE(SUM(d."xpEarned"), 0)::int AS xp
        FROM "CompetitionParticipant" p
        JOIN "User" u ON u."id" = p."userId"
        LEFT JOIN "DailyActivity" d
               ON d."userId" = p."userId"
              AND d."date" >= GREATEST(p."joinedAt", (${c.startsAt}::timestamptz AT TIME ZONE 'UTC'))::date
              AND d."date" <= (${windowEnd}::timestamptz AT TIME ZONE 'UTC')::date
       WHERE p."competitionId" = ${c.id}
       GROUP BY p."userId", u."fullName", p."joinedAt"
       ORDER BY xp DESC, p."joinedAt" ASC`);
    const ranked = rows.map((r, i) => ({ rank: i + 1, userId: r.userId, name: publicName(r.fullName), xpEarned: r.xp, isMe: r.userId === userId }));
    return {
      format: 'XP_WINDOW' as const,
      title: c.title,
      metric: 'XP earned during the competition',
      top: ranked.slice(0, limit),
      me: ranked.find((e) => e.isMe) ?? null,
    };
  }

  // ─── Review ─────────────────────────────────────────────────────────────────

  /** The student's own sitting with the right answers, once the competition has closed. */
  async review(userId: string, id: string) {
    const c = await this.load(id);
    if (c.format !== 'FIXED_SET') throw new BadRequestException('Nothing to review for this competition');
    if (c.status === 'PUBLISHED' || c.status === 'ACTIVE') {
      throw new BadRequestException('Answers are shown once the competition has closed, so nobody can pass them on');
    }
    const session = await this.prisma.quizSession.findUnique({ where: { userId_competitionId: { userId, competitionId: id } } });
    if (!session) throw new NotFoundException('You did not sit this competition');
    const [attempts, questions, entry] = await Promise.all([
      this.prisma.questionAttempt.findMany({ where: { userId, source: AttemptSource.COMPETITION, sourceRefId: session.id } }),
      this.prisma.question.findMany({ where: { id: { in: session.questionIds } }, include: { options: true } }),
      this.prisma.competitionParticipant.findUnique({ where: { competitionId_userId: { competitionId: id, userId } } }),
    ]);
    const given = new Map(attempts.map((a) => [a.questionId, a.selectedOptionId]));
    const byId = new Map(questions.map((q) => [q.id, q]));
    return {
      title: c.title,
      score: entry?.score ?? null,
      rank: entry?.rank ?? null,
      items: session.questionIds
        .map((qid) => byId.get(qid))
        .filter((q): q is NonNullable<typeof q> => !!q)
        .map((q) => ({
          questionId: q.id,
          questionText: q.questionText,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
          selectedOptionId: given.get(q.id) ?? null,
          correctOptionId: q.correctAnswerId,
          correct: given.get(q.id) === q.correctAnswerId,
          explanation: q.explanation,
        })),
    };
  }
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
