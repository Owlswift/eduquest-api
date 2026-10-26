import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ClassLevel, Prisma, Region } from '@prisma/client';
import { CacheService } from '../../common/cache/cache.service';
import { canonicalState } from '../../common/geo/nigerian-states';
import { REGION_LABEL, REGION_STATES, regionOfState } from '../../common/geo/regions';
import { publicName } from '../../common/names';
import { lagosDate } from '../../common/time/lagos';
import { PrismaService } from '../../database/prisma.service';

export type LeaderboardScope = 'national' | 'state' | 'region' | 'class';
export type LeaderboardPeriod = 'all' | 'weekly' | 'monthly';

export interface LeaderboardQuery {
  scope: LeaderboardScope;
  period: LeaderboardPeriod;
  /** Rank correct answers in this subject instead of XP. */
  subjectId?: string;
  /** Overrides; each defaults to the viewer's own. */
  state?: string;
  region?: Region;
  classLevel?: ClassLevel;
  limit: number;
}

/** A subject board only lists students who have answered at least this many questions in it. */
export const MIN_SUBJECT_ANSWERS = 20;
/** Days in each rolling window, counting today. */
export const PERIOD_DAYS = { weekly: 7, monthly: 30 } as const;
/** How long a board is reused. Rankings move slowly; this keeps the database calm. */
export const BOARD_TTL_SEC = 60;

const PERIOD_LABEL = { all: 'all time', weekly: 'this week', monthly: 'this month' } as const;

interface Row {
  id: string;
  fullName: string;
  state: string | null;
  classLevel: string;
  score: number;
  answered: number | null;
  rank: number;
}

/**
 * Rankings of students. Every board says exactly what it ranks (PRODUCT.md
 * section 7.2): lifetime XP, XP over a rolling week or month, or correct
 * answers in one subject, within the whole country, a state, a geopolitical
 * zone or a class. They are separate measures and never mixed. Each board is
 * one SQL query; the top of the list is cached briefly and the viewer's own
 * position is always read fresh.
 */
@Injectable()
export class LeaderboardsService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  /** The boards a student can switch between, with their own state, zone and class filled in. */
  async options(userId: string) {
    const [user, subjects] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { state: true, classLevel: true, subjects: true } }),
      this.prisma.subject.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    const state = canonicalState(user.state);
    const region = regionOfState(user.state);
    const mine: string[] = user.subjects ? safeArray(user.subjects) : [];
    return {
      periods: (['all', 'weekly', 'monthly'] as const).map((id) => ({ id, label: PERIOD_LABEL[id] })),
      scopes: [
        { id: 'national', label: 'Nigeria' },
        ...(state ? [{ id: 'state', label: state, value: state }] : []),
        ...(region ? [{ id: 'region', label: REGION_LABEL[region], value: region }] : []),
        { id: 'class', label: `${user.classLevel} students`, value: user.classLevel },
      ],
      regions: Object.keys(REGION_STATES).map((id) => ({ id, label: REGION_LABEL[id as Region] })),
      subjects: subjects.map((s) => ({ ...s, mine: mine.includes(s.id) })),
    };
  }

  /** The original `/users/leaderboard` shape (national XP) for clients that predate the new boards. */
  async legacy(userId: string, period: LeaderboardPeriod, limit: number) {
    const b = await this.board(userId, { scope: 'national', period, limit });
    return {
      top: b.entries.map((e) => ({ rank: e.rank, name: e.name, xp: e.score, isMe: e.isMe })),
      me: b.me ? { rank: b.me.rank, name: b.me.name, xp: b.me.score } : null,
    };
  }

  async board(userId: string, q: LeaderboardQuery) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { state: true, classLevel: true } });
    const filter = this.resolveFilter(q, user);
    const subject = q.subjectId ? await this.prisma.subject.findUnique({ where: { id: q.subjectId }, select: { id: true, name: true } }) : null;
    if (q.subjectId && !subject) throw new NotFoundException(`Subject ${q.subjectId} not found`);

    const metric = subject
      ? { key: 'correct_answers', label: `Correct answers in ${subject.name}` }
      : { key: 'xp', label: q.period === 'all' ? 'Lifetime XP' : `XP ${PERIOD_LABEL[q.period]}` };
    const title = `${metric.label}${subject && q.period !== 'all' ? `, ${PERIOD_LABEL[q.period]}` : ''} · ${filter.label}`;
    const key = `lb:${JSON.stringify([q.scope, q.period, q.subjectId ?? null, filter.key, q.limit])}`;

    const { value: top, cached } = await this.cache.remember(key, BOARD_TTL_SEC, () => this.topRows(q, filter.sql, subject?.id));
    const me = await this.myPosition(userId, q, filter.sql, subject?.id);

    return {
      title,
      metric,
      scope: { type: q.scope, label: filter.label },
      period: q.period,
      minSubjectAnswers: subject ? MIN_SUBJECT_ANSWERS : null,
      entries: top.map((r) => ({
        rank: r.rank,
        name: publicName(r.fullName),
        state: r.state,
        classLevel: r.classLevel,
        score: r.score,
        // Accuracy only makes sense next to correct-answer counts.
        accuracy: subject && r.answered ? Math.round((r.score / r.answered) * 100) : null,
        isMe: r.id === userId,
      })),
      me,
      cached,
    };
  }

  // ─── Scope filters ──────────────────────────────────────────────────────────

  private resolveFilter(q: LeaderboardQuery, user: { state: string | null; classLevel: ClassLevel }) {
    switch (q.scope) {
      case 'national':
        return { sql: Prisma.sql`TRUE`, label: 'Nigeria', key: 'ng' };
      case 'state': {
        const state = canonicalState(q.state ?? user.state);
        if (!state) {
          throw new BadRequestException(q.state ? `${q.state} is not a Nigerian state` : 'Set your state in your profile to see your state board');
        }
        return { sql: Prisma.sql`u."state" = ${state}`, label: state, key: `state:${state}` };
      }
      case 'region': {
        const region = q.region ?? regionOfState(user.state);
        if (!region) throw new BadRequestException('Set your state in your profile to see your zone board');
        return { sql: Prisma.sql`u."state" IN (${Prisma.join(REGION_STATES[region])})`, label: REGION_LABEL[region], key: `region:${region}` };
      }
      case 'class': {
        const cl = q.classLevel ?? user.classLevel;
        return { sql: Prisma.sql`u."classLevel" = ${cl}::"ClassLevel"`, label: `${cl} students`, key: `class:${cl}` };
      }
    }
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  /** The window's first day (inclusive), counting today in Lagos. */
  private windowStart(period: 'weekly' | 'monthly'): Date {
    const today = lagosDate();
    return new Date(today.getTime() - (PERIOD_DAYS[period] - 1) * 86_400_000);
  }

  /**
   * Builds the aggregation that yields one row per ranked student:
   * (id, fullName, state, classLevel, score, answered). Everything else
   * (ordering, ranking, the viewer's position) is layered on top.
   */
  private scored(q: LeaderboardQuery, filter: Prisma.Sql, subjectId?: string): Prisma.Sql {
    if (subjectId) {
      if (q.period === 'all') {
        return Prisma.sql`
          SELECT u."id", u."fullName", u."state", u."classLevel"::text AS "classLevel", u."createdAt",
                 s."correctAnswers"::int AS score, s."questionsAnswered"::int AS answered
            FROM "SubjectStat" s JOIN "User" u ON u."id" = s."userId"
           WHERE s."subjectId" = ${subjectId} AND s."questionsAnswered" >= ${MIN_SUBJECT_ANSWERS} AND s."correctAnswers" > 0
             AND u."role" = 'STUDENT' AND ${filter}`;
      }
      return Prisma.sql`
        SELECT u."id", u."fullName", u."state", u."classLevel"::text AS "classLevel", u."createdAt",
               (count(*) FILTER (WHERE a."correct"))::int AS score, count(*)::int AS answered
          FROM "QuestionAttempt" a JOIN "User" u ON u."id" = a."userId"
         WHERE a."subjectId" = ${subjectId} AND a."createdAt" >= ${this.windowStart(q.period)}
           AND u."role" = 'STUDENT' AND ${filter}
         GROUP BY u."id"
        HAVING count(*) >= ${MIN_SUBJECT_ANSWERS} AND count(*) FILTER (WHERE a."correct") > 0`;
    }
    if (q.period === 'all') {
      return Prisma.sql`
        SELECT u."id", u."fullName", u."state", u."classLevel"::text AS "classLevel", u."createdAt", u."xp"::int AS score, NULL::int AS answered
          FROM "User" u WHERE u."role" = 'STUDENT' AND u."xp" > 0 AND ${filter}`;
    }
    return Prisma.sql`
      SELECT u."id", u."fullName", u."state", u."classLevel"::text AS "classLevel", u."createdAt", SUM(d."xpEarned")::int AS score, NULL::int AS answered
        FROM "DailyActivity" d JOIN "User" u ON u."id" = d."userId"
       WHERE d."date" >= ${this.windowStart(q.period)}::date AND d."date" <= ${lagosDate()}::date AND u."role" = 'STUDENT' AND ${filter}
       GROUP BY u."id" HAVING SUM(d."xpEarned") > 0`;
  }

  private topRows(q: LeaderboardQuery, filter: Prisma.Sql, subjectId?: string): Promise<Row[]> {
    return this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT b."id", b."fullName", b."state", b."classLevel", b.score, b.answered,
             (RANK() OVER (ORDER BY b.score DESC))::int AS rank
        FROM (${this.scored(q, filter, subjectId)}) b
       ORDER BY b.score DESC, b."createdAt" ASC, b."id" ASC
       LIMIT ${q.limit}`);
  }

  /** Where this student stands on the board, read fresh (null when they are not on it). */
  private async myPosition(userId: string, q: LeaderboardQuery, filter: Prisma.Sql, subjectId?: string) {
    const rows = await this.prisma.$queryRaw<{ score: number; answered: number | null; rank: number; fullName: string }[]>(Prisma.sql`
      SELECT mine.score, mine.answered, mine."fullName",
             (1 + (SELECT count(*) FROM (${this.scored(q, filter, subjectId)}) o WHERE o.score > mine.score))::int AS rank
        FROM (${this.scored(q, filter, subjectId)}) mine
       WHERE mine."id" = ${userId}`);
    const r = rows[0];
    if (!r) return null;
    return { rank: r.rank, name: publicName(r.fullName), score: r.score, accuracy: subjectId && r.answered ? Math.round((r.score / r.answered) * 100) : null };
  }
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
