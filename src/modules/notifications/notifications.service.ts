import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PushService } from '../push/push.service';

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  /** Create an in-app notification and best-effort push it. Every other
   *  module calls this on its own meaningful events (badge earned, reward
   *  redeemed, competition joined, ...) rather than this module knowing
   *  about the rest of the app. */
  async notify(
    userId: string,
    type: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const notification = await this.prisma.notification.create({
      data: { userId, type, title, body, data: data ?? undefined },
    });
    // Fire-and-forget - a push failure shouldn't fail whatever action
    // triggered the notification (redeeming a reward, joining a
    // competition, ...).
    this.push.sendToUser(userId, title, body, data).catch(() => {});
    return notification;
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
