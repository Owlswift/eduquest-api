import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { REGION_STATES } from '../../common/geo/regions';
import { lagosDate } from '../../common/time/lagos';
import { PrismaService } from '../../database/prisma.service';
import { effectiveStatus } from '../competitions/competition-rules';
import { NotificationsService, ScheduledNotification } from '../notifications/notifications.service';

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Students count as "active" for broadcast notifications if they studied within this many days. */
const ACTIVE_WITHIN_DAYS = { broadcast: 30, dailyReady: 14 };
/** A winner is reminded this many days before the claim deadline. */
const CLAIM_REMINDER_DAYS = 3;

/**
 * The work done on a schedule. Every method is safe to run twice or to retry:
 * a notification carries a unique key (the competition, the user, the day), so
 * a second run finds it already sent. The scheduler (BullMQ) only decides
 * when; nothing here depends on it, so it also runs from the admin "run now"
 * action and from tests.
 */
@Injectable()
export class ScheduledTasksService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /** Housekeeping: drops refresh tokens that expired over a day ago and lapsed logout-blacklist entries. */
  async purgeExpiredTokens(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - DAY);
    const [refresh, blacklist] = await Promise.all([
      this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      this.prisma.blacklistedToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);
    return { refreshTokens: refresh.count, blacklisted: blacklist.count };
  }

  /** Persists competition status changes and announces competitions opening and about to close. */
  async advanceCompetitions(now: Date = new Date()) {
    const live = await this.prisma.competition.findMany({ where: { status: { in: ['PUBLISHED', 'ACTIVE'] } } });
    let advanced = 0;
    for (const c of live) {
      const next = effectiveStatus(c, now);
      if (next === c.status) continue;
      // Conditional on the old status, so a student's request that advanced it first isn't undone.
      const r = await this.prisma.competition.updateMany({ where: { id: c.id, status: c.status }, data: { status: next } });
      advanced += r.count;
      c.status = next;
    }

    let opened = 0;
    let closingSoon = 0;
    for (const c of live) {
      if (c.status !== 'ACTIVE') continue;
      // Opened in the last day: tell the students who can enter.
      if (now.getTime() - c.startsAt.getTime() < DAY) opened += await this.announceOpening(c, now);
      // Closes within a day: nudge entrants who have not finished.
      if (c.endsAt.getTime() - now.getTime() <= DAY && c.endsAt > now) closingSoon += await this.announceClosing(c);
    }
    return { advanced, opened, closingSoon };
  }

  private async announceOpening(c: Prisma.CompetitionGetPayload<object>, now: Date): Promise<number> {
    const since = new Date(lagosDate(now).getTime() - ACTIVE_WITHIN_DAYS.broadcast * DAY);
    const where: Prisma.UserWhereInput = {
      role: 'STUDENT',
      dailyActivities: { some: { date: { gte: since } } },
      ...(c.classLevels.length > 0 && { classLevel: { in: c.classLevels } }),
      ...(c.type === 'STATE' && c.state && { state: c.state }),
      ...(c.type === 'REGIONAL' && c.region && { state: { in: REGION_STATES[c.region] } }),
    };
    const students = await this.prisma.user.findMany({ where, select: { id: true } });
    const detail = [c.questionCount ? `${c.questionCount} questions` : null, c.timeLimitSec ? `${Math.round(c.timeLimitSec / 60)} minutes` : null].filter(Boolean).join(', ');
    return this.notifications.notifyMany(
      students.map((s) => ({
        userId: s.id,
        type: 'competition_open',
        title: `${c.title} is open`,
        body: `${detail ? `${detail}. ` : ''}Closes ${c.endsAt.toDateString()}.`,
        data: { competitionId: c.id },
        dedupeKey: `competition_open:${c.id}:${s.id}`,
      })),
    );
  }

  private async announceClosing(c: { id: string; title: string }): Promise<number> {
    const waiting = await this.prisma.competitionParticipant.findMany({
      where: { competitionId: c.id, status: { in: ['ENTERED', 'IN_PROGRESS'] } },
      select: { userId: true },
    });
    return this.notifications.notifyMany(
      waiting.map((p) => ({
        userId: p.userId,
        type: 'competition_closing',
        title: `${c.title} closes soon`,
        body: 'It closes within a day and you have not finished your sitting.',
        data: { competitionId: c.id },
        dedupeKey: `competition_closing:${c.id}:${p.userId}`,
      })),
    );
  }

  /**
   * Students who studied yesterday but not yet today, with a streak to lose.
   * (Checking yesterday, not just `streak > 0`, matters: the stored streak is
   * only recomputed when someone studies, so it can still show a streak that
   * already ended.)
   */
  async streakReminders(now: Date = new Date()) {
    const today = lagosDate(now);
    const yesterday = new Date(today.getTime() - DAY);
    const rows = await this.prisma.$queryRaw<{ id: string; streak: number }[]>(Prisma.sql`
      SELECT u."id", u."streak"
        FROM "User" u
       WHERE u."role" = 'STUDENT' AND u."streak" > 0
         AND EXISTS (SELECT 1 FROM "DailyActivity" y WHERE y."userId" = u."id" AND y."date" = ${yesterday}::date
                      AND (y."questionsAnswered" > 0 OR y."lessonsStudied" > 0))
         AND NOT EXISTS (SELECT 1 FROM "DailyActivity" t WHERE t."userId" = u."id" AND t."date" = ${today}::date
                          AND (t."questionsAnswered" > 0 OR t."lessonsStudied" > 0))`);
    const sent = await this.notifications.notifyMany(
      rows.map((r) => ({
        userId: r.id,
        type: 'streak_reminder',
        title: `Keep your ${r.streak} day streak`,
        body: 'Answer a few questions before midnight to keep it going.',
        dedupeKey: `streak_reminder:${r.id}:${ymd(today)}`,
      })),
    );
    return { candidates: rows.length, sent };
  }

  /** A morning prompt for recently active students: today's challenge is waiting. */
  async dailyChallengeReady(now: Date = new Date()) {
    const today = lagosDate(now);
    const since = new Date(today.getTime() - ACTIVE_WITHIN_DAYS.dailyReady * DAY);
    const students = await this.prisma.user.findMany({
      where: { role: 'STUDENT', dailyActivities: { some: { date: { gte: since } } } },
      select: { id: true },
    });
    const sent = await this.notifications.notifyMany(
      students.map((s) => ({
        userId: s.id,
        type: 'daily_challenge_ready',
        title: 'Today’s daily challenge is ready',
        body: 'Five questions, bonus XP and coins.',
        dedupeKey: `daily_ready:${s.id}:${ymd(today)}`,
      })),
    );
    return { candidates: students.length, sent };
  }

  /** Winners who have not claimed, a few days before the claim period ends. */
  async prizeClaimReminders(now: Date = new Date()) {
    const awards = await this.prisma.prizeAward.findMany({
      where: { status: 'AWAITING_CLAIM', claimDeadline: { gt: now, lte: new Date(now.getTime() + CLAIM_REMINDER_DAYS * DAY) } },
      include: { prize: true },
    });
    const items: ScheduledNotification[] = awards.map((a) => ({
      userId: a.userId,
      type: 'prize_claim_reminder',
      title: `Claim your prize: ${a.prize.title}`,
      body: `Claim it by ${a.claimDeadline.toDateString()} or it passes to the next place.`,
      data: { awardId: a.id },
      dedupeKey: `claim_reminder:${a.id}`,
    }));
    return { candidates: awards.length, sent: await this.notifications.notifyMany(items) };
  }
}
