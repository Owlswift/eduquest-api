import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Tracks per-day study activity (one row per user per calendar day, in
 * Africa/Lagos time) and derives the streak counter and daily-goal
 * progress the Learn screen shows.
 */
@Injectable()
export class ActivityService {
  /** Questions/day the "Today's Goal" card counts toward. */
  static readonly DAILY_GOAL = 20;

  /** How far back recomputeStreak looks - a streak longer than this is
   *  capped, which is fine for display purposes. */
  private static readonly STREAK_LOOKBACK_DAYS = 60;

  private static readonly WEEKDAY_LABELS = [
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat',
    'Sun',
  ];

  constructor(private prisma: PrismaService) {}

  /** UTC-midnight Date for the given instant's calendar day in Lagos
   *  (UTC+1, no DST). Stored as-is in a Prisma `@db.Date` column. */
  private lagosDate(instant: Date = new Date()): Date {
    const lagos = new Date(instant.getTime() + 60 * 60 * 1000);
    return new Date(
      Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()),
    );
  }

  private ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private addDays(d: Date, n: number): Date {
    const copy = new Date(d);
    copy.setUTCDate(copy.getUTCDate() + n);
    return copy;
  }

  /** Record that the user answered `count` questions today. No-op for
   *  count <= 0. Recomputes the streak afterwards. */
  async recordQuestions(userId: string, count: number): Promise<void> {
    if (!count || count <= 0) return;
    const date = this.lagosDate();
    await this.prisma.dailyActivity.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, questionsAnswered: count },
      update: { questionsAnswered: { increment: count } },
    });
    await this.recomputeStreak(userId);
  }

  /** Record one lesson interaction (a tutor turn) for today. */
  async recordLesson(userId: string): Promise<void> {
    const date = this.lagosDate();
    await this.prisma.dailyActivity.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, lessonsStudied: 1 },
      update: { lessonsStudied: { increment: 1 } },
    });
    await this.recomputeStreak(userId);
  }

  /** Walk back from today counting consecutive active days and persist the
   *  result to `User.streak`. Today not yet being active doesn't break a
   *  streak - it just isn't counted until the student studies. */
  async recomputeStreak(userId: string): Promise<number> {
    const today = this.lagosDate();
    const since = this.addDays(today, -ActivityService.STREAK_LOOKBACK_DAYS);

    const rows = await this.prisma.dailyActivity.findMany({
      where: {
        userId,
        date: { gte: since },
        OR: [
          { questionsAnswered: { gt: 0 } },
          { lessonsStudied: { gt: 0 } },
        ],
      },
      select: { date: true },
    });
    const activeDays = new Set(rows.map((r) => this.ymd(r.date)));

    let cursor = today;
    if (!activeDays.has(this.ymd(cursor))) {
      cursor = this.addDays(cursor, -1);
    }
    let streak = 0;
    while (activeDays.has(this.ymd(cursor))) {
      streak += 1;
      cursor = this.addDays(cursor, -1);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { streak },
    });
    return streak;
  }

  /** The Learn screen's daily summary: streak, this week's Mon-Sun study
   *  strip, and progress toward today's question goal. */
  async getDailySummary(userId: string) {
    const today = this.lagosDate();
    const mondayOffset = (today.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = this.addDays(today, -mondayOffset);
    const sunday = this.addDays(monday, 6);

    const [rows, user] = await Promise.all([
      this.prisma.dailyActivity.findMany({
        where: { userId, date: { gte: monday, lte: sunday } },
        select: {
          date: true,
          questionsAnswered: true,
          lessonsStudied: true,
        },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { streak: true },
      }),
    ]);

    const byDay = new Map(rows.map((r) => [this.ymd(r.date), r]));
    const todayKey = this.ymd(today);

    const week = ActivityService.WEEKDAY_LABELS.map((label, i) => {
      const d = this.addDays(monday, i);
      const key = this.ymd(d);
      const row = byDay.get(key);
      const studied =
        !!row && (row.questionsAnswered > 0 || row.lessonsStudied > 0);
      return { date: key, weekday: label, studied, isToday: key === todayKey };
    });

    const answeredToday = byDay.get(todayKey)?.questionsAnswered ?? 0;
    const target = ActivityService.DAILY_GOAL;

    return {
      streak: user?.streak ?? 0,
      goal: {
        target,
        answeredToday,
        percent: Math.min(100, Math.round((answeredToday / target) * 100)),
      },
      week,
    };
  }
}
