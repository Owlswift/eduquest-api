import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../ledger/ledger.service';
import { REWARDS_CATALOG } from './rewards.catalog';

@Injectable()
export class RewardsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private ledger: LedgerService,
  ) {}

  // ─── GET /rewards ─────────────────────────────────────────────────────────

  async list(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });
    const coins = user?.coins ?? 0;

    return {
      coins,
      rewards: REWARDS_CATALOG.map((r) => ({
        ...r,
        canAfford: coins >= r.coinCost,
      })),
    };
  }

  // ─── POST /rewards/:id/redeem ─────────────────────────────────────────────

  async redeem(userId: string, rewardId: string) {
    const reward = REWARDS_CATALOG.find((r) => r.id === rewardId);
    if (!reward) throw new NotFoundException('Unknown reward');

    // Balance check, debit, ledger row and redemption record commit
    // together. The debit is one conditional UPDATE (`coins >= cost`), so
    // concurrent redemptions can't drive the balance negative.
    const { coins } = await this.prisma.$transaction(async (tx) => {
      const redemption = await tx.rewardRedemption.create({
        data: {
          userId,
          rewardId: reward.id,
          title: reward.title,
          coinCost: reward.coinCost,
        },
      });
      return this.ledger.spendCoins(
        {
          userId,
          coins: reward.coinCost,
          reason: 'redemption',
          key: `redemption:${redemption.id}`,
          refType: 'redemption',
          refId: redemption.id,
        },
        tx,
      );
    });

    await this.notifications.notify(
      userId,
      'reward_redeemed',
      '🎁 Reward redeemed!',
      `You redeemed ${reward.title} for ${reward.coinCost} coins.`,
      { rewardId: reward.id },
    );

    return { redeemed: true, coins };
  }

  // ─── GET /rewards/history ──────────────────────────────────────────────────

  async history(userId: string) {
    const redemptions = await this.prisma.rewardRedemption.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return redemptions.map((r) => ({
      id: r.id,
      rewardId: r.rewardId,
      title: r.title,
      coinCost: r.coinCost,
      status: r.status,
      redeemedAt: r.createdAt,
      fulfilledAt: r.fulfilledAt,
    }));
  }

  // ─── Admin fulfillment queue ──────────────────────────────────────────────
  // No vendor/payment integration - real-world delivery (airtime, data,
  // etc.) is handled manually by whoever runs that; this just gives them a
  // queue to work from instead of redemptions vanishing into a black hole.

  async adminQueue() {
    const redemptions = await this.prisma.rewardRedemption.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { fullName: true, email: true, phone: true } } },
    });
    return redemptions.map((r) => ({
      id: r.id,
      rewardId: r.rewardId,
      title: r.title,
      coinCost: r.coinCost,
      redeemedAt: r.createdAt,
      student: {
        fullName: r.user.fullName,
        email: r.user.email,
        phone: r.user.phone,
      },
    }));
  }

  async adminFulfill(redemptionId: string) {
    const redemption = await this.prisma.rewardRedemption.findUnique({
      where: { id: redemptionId },
    });
    if (!redemption) throw new NotFoundException('Redemption not found');
    if (redemption.status !== 'PENDING') {
      throw new BadRequestException(`Redemption is already ${redemption.status.toLowerCase()}`);
    }

    // Conditional on PENDING so two admins (or a double-click) can't both
    // act on the same redemption.
    const done = await this.prisma.rewardRedemption.updateMany({
      where: { id: redemptionId, status: 'PENDING' },
      data: { status: 'FULFILLED', fulfilledAt: new Date() },
    });
    if (done.count === 0) throw new BadRequestException('Redemption is no longer pending');

    await this.notifications.notify(
      redemption.userId,
      'reward_fulfilled',
      '✅ Reward delivered!',
      `Your ${redemption.title} has been sent.`,
      { rewardId: redemption.rewardId },
    );

    return { fulfilled: true };
  }

  /** Couldn't actually deliver it (out of stock, bad phone number, etc.) -
   *  refund the coins rather than leave the student having paid for
   *  nothing. */
  async adminReject(redemptionId: string, reason?: string) {
    const redemption = await this.prisma.rewardRedemption.findUnique({
      where: { id: redemptionId },
    });
    if (!redemption) throw new NotFoundException('Redemption not found');
    if (redemption.status !== 'PENDING') {
      throw new BadRequestException(`Redemption is already ${redemption.status.toLowerCase()}`);
    }

    // The status flip and the refund commit together, and the flip only
    // matches a still-PENDING row - so the refund is paid exactly once (the
    // ledger key is a second guard).
    await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.rewardRedemption.updateMany({
        where: { id: redemptionId, status: 'PENDING' },
        data: { status: 'REJECTED', fulfilledAt: new Date() },
      });
      if (flipped.count === 0) throw new BadRequestException('Redemption is no longer pending');
      await this.ledger.grant(
        {
          userId: redemption.userId,
          coins: redemption.coinCost,
          reason: 'redemption_refund',
          key: `redemption_refund:${redemptionId}`,
          refType: 'redemption',
          refId: redemptionId,
        },
        tx,
      );
    });

    await this.notifications.notify(
      redemption.userId,
      'reward_rejected',
      '⚠️ Reward redemption failed',
      `We couldn't deliver your ${redemption.title}${reason ? ` (${reason})` : ''} - your ${redemption.coinCost} coins have been refunded.`,
      { rewardId: redemption.rewardId },
    );

    return { rejected: true, refunded: redemption.coinCost };
  }
}
