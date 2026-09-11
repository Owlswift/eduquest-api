import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { REWARDS_CATALOG } from './rewards.catalog';

@Injectable()
export class RewardsService {
  constructor(private prisma: PrismaService) {}

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

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.coins < reward.coinCost) {
      throw new BadRequestException('Not enough coins for this reward');
    }

    const [updatedUser] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { coins: { decrement: reward.coinCost } },
        select: { coins: true },
      }),
      this.prisma.rewardRedemption.create({
        data: {
          userId,
          rewardId: reward.id,
          title: reward.title,
          coinCost: reward.coinCost,
        },
      }),
    ]);

    return { redeemed: true, coins: updatedUser.coins };
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
      redeemedAt: r.createdAt,
    }));
  }
}
