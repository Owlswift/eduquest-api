import { Injectable, OnModuleInit } from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AchievementsService } from './achievements.service';
import { levelTitle } from './levels';

/** Reacts to progression events. Currently: a level-up tells the student and
 *  can unlock level achievements. */
@Injectable()
export class GamificationService implements OnModuleInit {
  constructor(
    private ledger: LedgerService,
    private notifications: NotificationsService,
    private achievements: AchievementsService,
  ) {}

  onModuleInit() {
    this.ledger.onLevelUp(async ({ userId, to }) => {
      await this.notifications.notify(
        userId,
        'level_up',
        `You reached level ${to}`,
        `Welcome to ${levelTitle(to)}. Keep going.`,
        { level: String(to) },
      );
      await this.achievements.evaluate(userId);
    });
  }
}
