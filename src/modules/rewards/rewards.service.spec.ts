import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RewardsService } from './rewards.service';

describe('RewardsService', () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    rewardRedemption: { create: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let notifications: { notify: jest.Mock };
  let service: RewardsService;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      rewardRedemption: { create: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn(),
    };
    notifications = { notify: jest.fn() };
    service = new RewardsService(prisma as any, notifications as any);
  });

  describe('list', () => {
    it('marks affordability against the caller\'s coin balance', async () => {
      prisma.user.findUnique.mockResolvedValue({ coins: 900 });

      const result = await service.list('u1');

      expect(result.coins).toBe(900);
      const airtime = result.rewards.find((r) => r.id === 'airtime_500')!;
      const laptop = result.rewards.find((r) => r.id === 'laptop')!;
      expect(airtime.canAfford).toBe(true);
      expect(laptop.canAfford).toBe(false);
    });

    it('treats a missing user as zero coins', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.list('ghost');
      expect(result.coins).toBe(0);
      expect(result.rewards.every((r) => !r.canAfford)).toBe(true);
    });
  });

  describe('redeem', () => {
    it('throws for an unknown reward id', async () => {
      await expect(service.redeem('u1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects redemption when the user cannot afford it', async () => {
      prisma.user.findUnique.mockResolvedValue({ coins: 100 });
      await expect(service.redeem('u1', 'airtime_500')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('decrements coins and records the redemption transactionally', async () => {
      prisma.user.findUnique.mockResolvedValue({ coins: 1000 });
      prisma.$transaction.mockResolvedValue([{ coins: 500 }, {}]);

      const result = await service.redeem('u1', 'airtime_500');

      expect(result).toEqual({ redeemed: true, coins: 500 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        'u1',
        'reward_redeemed',
        expect.any(String),
        expect.any(String),
        { rewardId: 'airtime_500' },
      );
    });
  });

  describe('history', () => {
    it('maps redemption rows to the response shape', async () => {
      const createdAt = new Date('2026-06-01');
      prisma.rewardRedemption.findMany.mockResolvedValue([
        { id: 'r1', rewardId: 'airtime_500', title: 'Airtime', coinCost: 500, createdAt },
      ]);

      const result = await service.history('u1');

      expect(result).toEqual([
        { id: 'r1', rewardId: 'airtime_500', title: 'Airtime', coinCost: 500, redeemedAt: createdAt },
      ]);
    });
  });
});
