import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Sends push notifications via Firebase Cloud Messaging. Needs
 * FIREBASE_SERVICE_ACCOUNT_JSON (the service account key, as a JSON
 * string) in the environment - until that's set, sends are logged
 * instead, so the rest of the app (and every caller of this service)
 * keeps working without a Firebase project configured.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private messaging: import('firebase-admin/messaging').Messaging | null = null;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!json) {
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT_JSON not set - push notifications will be logged, not sent.',
      );
      return;
    }
    try {
      // Lazy require so the firebase-admin App/Credential machinery only
      // spins up when a project is actually configured.
      const { initializeApp, cert } = require('firebase-admin/app');
      const { getMessaging } = require('firebase-admin/messaging');
      const app = initializeApp({ credential: cert(JSON.parse(json)) });
      this.messaging = getMessaging(app);
      this.logger.log('Firebase Admin initialized - push notifications are live.');
    } catch (err) {
      this.logger.error('Failed to initialize Firebase Admin - push notifications disabled.', err as Error);
    }
  }

  /** Register a device's FCM token for a user (idempotent - re-registering
   *  the same token just re-points it at this user, e.g. after login as a
   *  different account on the same device). */
  async registerToken(userId: string, token: string, platform: 'ios' | 'android') {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    return { registered: true };
  }

  async unregisterToken(token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
    return { unregistered: true };
  }

  /** Push to every device registered for a user. Best-effort: a failure
   *  (including "not configured") is logged and swallowed - push is a
   *  bonus on top of the in-app notification, never a blocker for it. */
  async sendToUser(userId: string, title: string, body: string, data?: Record<string, string>) {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, token: true },
    });
    if (tokens.length === 0) return;

    if (!this.messaging) {
      this.logger.warn(`Would have pushed "${title}" to ${tokens.length} device(s) for user ${userId}`);
      return;
    }

    try {
      const response = await this.messaging.sendEachForMulticast({
        tokens: tokens.map((t) => t.token),
        notification: { title, body },
        data,
      });
      // Clean up tokens FCM says are dead (uninstalled app, expired, etc).
      const deadTokenIds = response.responses
        .map((r, i) => (r.success ? null : tokens[i].id))
        .filter((id): id is string => id !== null);
      if (deadTokenIds.length > 0) {
        await this.prisma.deviceToken.deleteMany({ where: { id: { in: deadTokenIds } } });
      }
    } catch (err) {
      this.logger.error(`Push send failed for user ${userId}`, err as Error);
    }
  }
}
