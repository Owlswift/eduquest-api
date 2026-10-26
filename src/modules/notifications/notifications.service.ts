import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PushService } from '../push/push.service';
import { DEFAULT_PREFERENCES, isAllowed, Preferences } from './notification-categories';

export interface ScheduledNotification {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Unique per message: a repeat with the same key is dropped. */
  dedupeKey: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  /** Create an in-app notification and best-effort push it. Every other
   *  module calls this on its own meaningful events (badge earned, reward
   *  redeemed, competition joined, ...) rather than this module knowing
   *  about the rest of the app. A student who switched that category off gets
   *  nothing (money and prize messages are never switchable), and one who
   *  turned push off still gets the in-app notification. With a `dedupeKey`
   *  a repeat is dropped. Resolves to null when nothing was sent. */
  async notify(
    userId: string,
    type: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: { dedupeKey?: string },
  ) {
    const prefs = await this.preferencesFor(userId);
    if (!isAllowed(type, prefs)) return null;

    let notification;
    if (options?.dedupeKey) {
      const made = await this.prisma.notification.createMany({
        data: [{ userId, type, title, body, data: data ?? undefined, dedupeKey: options.dedupeKey }],
        skipDuplicates: true,
      });
      if (made.count === 0) return null;
      notification = await this.prisma.notification.findUnique({ where: { dedupeKey: options.dedupeKey } });
    } else {
      notification = await this.prisma.notification.create({ data: { userId, type, title, body, data: data ?? undefined } });
    }
    // Fire-and-forget - a push failure shouldn't fail whatever action
    // triggered the notification (redeeming a reward, joining a
    // competition, ...).
    if (prefs.push) this.push.sendToUser(userId, title, body, data).catch(() => {});
    return notification;
  }

  /**
   * Sends many scheduled notifications at once (a competition opening, a daily
   * reminder). Respects each student's preferences, inserts in one statement
   * per chunk, drops anything already sent under the same key, and pushes only
   * to those who actually got a new one. Resolves to how many were sent.
   */
  async notifyMany(items: ScheduledNotification[], chunkSize = 500): Promise<number> {
    let sent = 0;
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      const prefs = await this.preferencesForMany([...new Set(chunk.map((c) => c.userId))]);
      const allowed = chunk.filter((c) => isAllowed(c.type, prefs.get(c.userId) ?? DEFAULT_PREFERENCES));
      if (allowed.length === 0) continue;

      const values = allowed.map(
        (c) => Prisma.sql`(gen_random_uuid()::text, ${c.userId}, ${c.type}, ${c.title}, ${c.body}, ${c.data ? JSON.stringify(c.data) : null}::jsonb, ${c.dedupeKey}, NOW())`,
      );
      const inserted = await this.prisma.$queryRaw<{ dedupeKey: string }[]>(Prisma.sql`
        INSERT INTO "Notification" ("id", "userId", "type", "title", "body", "data", "dedupeKey", "createdAt")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("dedupeKey") DO NOTHING
        RETURNING "dedupeKey"`);
      const fresh = new Set(inserted.map((r) => r.dedupeKey));
      sent += fresh.size;
      for (const c of allowed) {
        if (fresh.has(c.dedupeKey) && (prefs.get(c.userId) ?? DEFAULT_PREFERENCES).push) {
          this.push.sendToUser(c.userId, c.title, c.body, c.data).catch(() => {});
        }
      }
    }
    return sent;
  }

  // ─── Preferences ───────────────────────────────────────────────────────────

  async preferencesFor(userId: string): Promise<Preferences> {
    const p = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    return p ? { studyReminders: p.studyReminders, competitions: p.competitions, achievements: p.achievements, push: p.push } : { ...DEFAULT_PREFERENCES };
  }

  private async preferencesForMany(userIds: string[]): Promise<Map<string, Preferences>> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId: { in: userIds } } });
    return new Map(rows.map((p) => [p.userId, { studyReminders: p.studyReminders, competitions: p.competitions, achievements: p.achievements, push: p.push }]));
  }

  async updatePreferences(userId: string, changes: Partial<Preferences>): Promise<Preferences> {
    // An upsert with nothing to update is a read-then-create, so two first
    // calls at once collide on the unique userId. Insert-if-missing is atomic.
    await this.prisma.notificationPreference.createMany({ data: [{ userId }], skipDuplicates: true });
    const p = Object.keys(changes).length
      ? await this.prisma.notificationPreference.update({ where: { userId }, data: changes })
      : await this.prisma.notificationPreference.findUniqueOrThrow({ where: { userId } });
    return { studyReminders: p.studyReminders, competitions: p.competitions, achievements: p.achievements, push: p.push };
  }

  // ─── GET /notifications ────────────────────────────────────────────────────

  async list(userId: string, limit = 30) {
    const notifications = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data,
      read: n.read,
      createdAt: n.createdAt,
    }));
  }

  // ─── GET /notifications/unread-count ───────────────────────────────────────

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }

  // ─── POST /notifications/:id/read ──────────────────────────────────────────

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
    return { read: true };
  }

  // ─── POST /notifications/read-all ──────────────────────────────────────────

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { read: true };
  }
}
