import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RedemptionStatus } from '@prisma/client';
import { AuditService } from '../admin/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Statuses a redemption can still be closed from. */
const OPEN: RedemptionStatus[] = ['PENDING', 'APPROVED'];
/** Below this many left, students are shown how many remain. */
const LOW_STOCK = 5;

@Injectable()
export class RewardsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private ledger: LedgerService,
    private audit: AuditService,
  ) {}

  // ─── GET /rewards ─────────────────────────────────────────────────────────

  async list(userId: string) {
    const [user, rewards] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { coins: true } }),
      this.prisma.reward.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { coinCost: 'asc' }] }),
    ]);
    const coins = user?.coins ?? 0;
    return {
      coins,
      rewards: rewards.map((r) => {
        const inStock = r.stock === null || r.stock > 0;
        return {
          id: r.id,
          title: r.title,
          subtitle: r.subtitle,
          description: r.description,
          coinCost: r.coinCost,
          kind: r.kind,
          imageKey: r.imageKey,
          inStock,
          // Shown only when it is about to run out.
          stockLeft: r.stock !== null && r.stock > 0 && r.stock <= LOW_STOCK ? r.stock : null,
          canAfford: inStock && coins >= r.coinCost,
          coinsNeeded: Math.max(0, r.coinCost - coins),
        };
      }),
    };
  }

  // ─── POST /rewards/:id/redeem ─────────────────────────────────────────────

  async redeem(userId: string, rewardId: string) {
    const { coins, reward } = await this.prisma.$transaction(async (tx) => {
      // Take one unit of stock first. It is one conditional UPDATE, so ten
      // students racing for the last one cannot all get it; if the coin debit
      // below then fails, the whole transaction (including this) rolls back.
      const taken = await tx.reward.updateMany({
        where: { id: rewardId, active: true, OR: [{ stock: null }, { stock: { gt: 0 } }] },
        data: { stock: { decrement: 1 } },
      });
      if (taken.count === 0) {
        const r = await tx.reward.findUnique({ where: { id: rewardId }, select: { active: true } });
        if (!r) throw new NotFoundException('Unknown reward');
        throw new BadRequestException(r.active ? 'This reward is out of stock' : 'This reward is no longer available');
      }
      const reward = await tx.reward.findUniqueOrThrow({ where: { id: rewardId } });
      const redemption = await tx.rewardRedemption.create({
        // The title and price are copied: editing the reward later never rewrites this record.
        data: { userId, rewardId, title: reward.title, coinCost: reward.coinCost },
      });
      const { coins } = await this.ledger.spendCoins(
        { userId, coins: reward.coinCost, reason: 'redemption', key: `redemption:${redemption.id}`, refType: 'redemption', refId: redemption.id },
        tx,
      );
      return { coins, reward };
    });

    await this.notifications.notify(userId, 'reward_redeemed', 'Reward requested', `You redeemed ${reward.title} for ${reward.coinCost} coins. We will confirm once it is on its way.`, { rewardId });
    return { redeemed: true, coins };
  }

  // ─── GET /rewards/history ──────────────────────────────────────────────────

  async history(userId: string) {
    const redemptions = await this.prisma.rewardRedemption.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return redemptions.map((r) => ({
      id: r.id,
      rewardId: r.rewardId,
      title: r.title,
      coinCost: r.coinCost,
      status: r.status,
      redeemedAt: r.createdAt,
      fulfilledAt: r.fulfilledAt,
      closedAt: r.closedAt,
      note: r.note,
      // Only a request nobody has started on can be taken back.
      canCancel: r.status === 'PENDING',
    }));
  }

  // ─── POST /rewards/redemptions/:id/cancel ──────────────────────────────────

  /** A student takes back a request that is still pending: coins and stock come back. */
  async cancel(userId: string, redemptionId: string) {
    const r = await this.prisma.rewardRedemption.findFirst({ where: { id: redemptionId, userId } });
    if (!r) throw new NotFoundException('Redemption not found');
    await this.closeWithRefund(r, 'CANCELLED', ['PENDING'], 'Cancelled by the student', 'This request can no longer be cancelled');
    await this.notifications.notify(userId, 'reward_cancelled', 'Request cancelled', `${r.coinCost} coins were returned for ${r.title}.`, { rewardId: r.rewardId });
    return { cancelled: true, refunded: r.coinCost };
  }

  // ─── Admin fulfillment queue ──────────────────────────────────────────────
  // No vendor/payment integration - real-world delivery (airtime, data, etc.)
  // is handled manually by whoever runs that.

  async adminQueue() {
    const redemptions = await this.prisma.rewardRedemption.findMany({
      where: { status: { in: OPEN } },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { fullName: true, email: true, phone: true } } },
    });
    return redemptions.map((r) => ({
      id: r.id,
      rewardId: r.rewardId,
      title: r.title,
      coinCost: r.coinCost,
      status: r.status,
      redeemedAt: r.createdAt,
      approvedAt: r.approvedAt,
      student: { fullName: r.user.fullName, email: r.user.email, phone: r.user.phone },
    }));
  }

  /** Checked and being arranged. The coins were already taken when it was requested. */
  async adminApprove(adminId: string, redemptionId: string) {
    const r = await this.redemption(redemptionId);
    const done = await this.prisma.rewardRedemption.updateMany({ where: { id: redemptionId, status: 'PENDING' }, data: { status: 'APPROVED', approvedAt: new Date() } });
    if (done.count === 0) throw new ConflictException(`Redemption is already ${r.status.toLowerCase()}`);
    await this.audit.log({ adminId, action: 'redemption.approve', entityType: 'redemption', entityId: redemptionId, summary: `Approved ${r.title}`, before: { status: 'PENDING' }, after: { status: 'APPROVED' } });
    await this.notifications.notify(r.userId, 'reward_approved', 'Reward approved', `${r.title} is being arranged.`, { rewardId: r.rewardId });
    return { approved: true };
  }

  async adminFulfill(adminId: string, redemptionId: string, note?: string) {
    const r = await this.redemption(redemptionId);
    // Conditional on still being open, so two admins (or a double click) can't both act.
    const done = await this.prisma.rewardRedemption.updateMany({
      where: { id: redemptionId, status: { in: OPEN } },
      data: { status: 'FULFILLED', fulfilledAt: new Date(), note: note ?? null },
    });
    if (done.count === 0) throw new ConflictException(`Redemption is already ${r.status.toLowerCase()}`);
    await this.audit.log({ adminId, action: 'redemption.fulfil', entityType: 'redemption', entityId: redemptionId, summary: `Delivered ${r.title}`, before: { status: r.status }, after: { status: 'FULFILLED' } });
    await this.notifications.notify(r.userId, 'reward_fulfilled', 'Reward delivered', `Your ${r.title} has been sent.`, { rewardId: r.rewardId });
    return { fulfilled: true };
  }

  /** Couldn't deliver it (out of stock, bad number): refund the coins and put the unit back. */
  async adminReject(adminId: string, redemptionId: string, reason?: string) {
    const r = await this.redemption(redemptionId);
    await this.closeWithRefund(r, 'REJECTED', OPEN, reason ?? 'Could not be delivered', `Redemption is already ${r.status.toLowerCase()}`);
    await this.audit.log({ adminId, action: 'redemption.reject', entityType: 'redemption', entityId: redemptionId, summary: `Rejected ${r.title}${reason ? `: ${reason}` : ''}`, before: { status: r.status }, after: { status: 'REJECTED' } });
    await this.notifications.notify(
      r.userId,
      'reward_rejected',
      'Reward could not be delivered',
      `We couldn't deliver your ${r.title}${reason ? ` (${reason})` : ''} - your ${r.coinCost} coins have been refunded.`,
      { rewardId: r.rewardId },
    );
    return { rejected: true, refunded: r.coinCost };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async redemption(id: string) {
    const r = await this.prisma.rewardRedemption.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Redemption not found');
    return r;
  }

  /** Closes a request without delivery. The status flip is the gate, so the
   *  refund and the restock happen exactly once however many tap at once. */
  private async closeWithRefund(
    r: { id: string; userId: string; rewardId: string; coinCost: number },
    status: 'CANCELLED' | 'REJECTED',
    from: RedemptionStatus[],
    note: string,
    conflictMessage: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.rewardRedemption.updateMany({ where: { id: r.id, status: { in: from } }, data: { status, closedAt: new Date(), note } });
      if (flipped.count === 0) throw new ConflictException(conflictMessage);
      await this.ledger.grant(
        { userId: r.userId, coins: r.coinCost, reason: 'redemption_refund', key: `redemption_refund:${r.id}`, refType: 'redemption', refId: r.id },
        tx,
      );
      // Put the unit back (only meaningful for a reward with limited stock).
      await tx.reward.updateMany({ where: { id: r.rewardId, stock: { not: null } }, data: { stock: { increment: 1 } } });
    });
  }
}

