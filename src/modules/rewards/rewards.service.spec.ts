import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RewardsService } from './rewards.service';

describe('RewardsService', () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    rewardRedemption: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let notifications: { notify: jest.Mock };
  let ledger: { spendCoins: jest.Mock; grant: jest.Mock };
  let tx: { rewardRedemption: { create: jest.Mock; updateMany: jest.Mock } };
  let service: RewardsService;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      rewardRedemption: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    tx = { rewardRedemption: { create: jest.fn(), updateMany: jest.fn() } };
    // Interactive transactions: run the callback against the tx stand-in.
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));
    ledger = { spendCoins: jest.fn(), grant: jest.fn() };
    notifications = { notify: jest.fn() };
    service = new RewardsService(prisma as any, notifications as any, ledger as any);
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

    it('rejects redemption when the ledger refuses the debit (not enough coins)', async () => {
      tx.rewardRedemption.create.mockResolvedValue({ id: 'r1' });
      ledger.spendCoins.mockRejectedValue(new BadRequestException('Not enough coins'));

      await expect(service.redeem('u1', 'airtime_500')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('records the redemption and debits through the ledger in one transaction', async () => {
      tx.rewardRedemption.create.mockResolvedValue({ id: 'r1' });
      ledger.spendCoins.mockResolvedValue({ coins: 500 });

      const result = await service.redeem('u1', 'airtime_500');

      expect(result).toEqual({ redeemed: true, coins: 500 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(ledger.spendCoins).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          coins: 500,
          reason: 'redemption',
          key: 'redemption:r1',
        }),
        tx,
      );
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
    it('maps redemption rows to the response shape, including fulfillment status', async () => {
      const createdAt = new Date('2026-06-01');
      prisma.rewardRedemption.findMany.mockResolvedValue([
        {
          id: 'r1',
          rewardId: 'airtime_500',
          title: 'Airtime',
          coinCost: 500,
          status: 'PENDING',
          createdAt,
          fulfilledAt: null,
        },
      ]);

      const result = await service.history('u1');

      expect(result).toEqual([
        {
          id: 'r1',
          rewardId: 'airtime_500',
          title: 'Airtime',
          coinCost: 500,
          status: 'PENDING',
          redeemedAt: createdAt,
          fulfilledAt: null,
        },
      ]);
    });
  });

  describe('adminQueue', () => {
    it('lists only pending redemptions with student contact info', async () => {
      prisma.rewardRedemption.findMany.mockResolvedValue([
        {
          id: 'r1',
          rewardId: 'airtime_500',
          title: 'Airtime',
          coinCost: 500,
          createdAt: new Date('2026-06-01'),
          user: { fullName: 'ola law', email: 'ola@x.com', phone: '080' },
        },
      ]);

      const result = await service.adminQueue();

      expect(prisma.rewardRedemption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'PENDING' } }),
      );
      expect(result[0].student).toEqual({
        fullName: 'ola law',
        email: 'ola@x.com',
        phone: '080',
      });
    });
  });

  describe('adminFulfill', () => {
    it('marks a pending redemption fulfilled and notifies the student', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        rewardId: 'airtime_500',
        title: 'Airtime',
        coinCost: 500,
        status: 'PENDING',
      });

      prisma.rewardRedemption.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.adminFulfill('r1');

      expect(result).toEqual({ fulfilled: true });
      expect(prisma.rewardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', status: 'PENDING' },
        data: { status: 'FULFILLED', fulfilledAt: expect.any(Date) },
      });
      expect(notifications.notify).toHaveBeenCalledWith(
        'u1',
        'reward_fulfilled',
        expect.any(String),
        expect.any(String),
        { rewardId: 'airtime_500' },
      );
    });

    it('throws for an unknown redemption', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue(null);
      await expect(service.adminFulfill('ghost')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loses the race when another admin resolved it first', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue({ id: 'r1', status: 'PENDING' });
      prisma.rewardRedemption.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.adminFulfill('r1')).rejects.toBeInstanceOf(BadRequestException);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('rejects fulfilling something already resolved', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue({ id: 'r1', status: 'FULFILLED' });
      await expect(service.adminFulfill('r1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('adminReject', () => {
    it('marks rejected, refunds the coins, and notifies the student', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        rewardId: 'airtime_500',
        title: 'Airtime',
        coinCost: 500,
        status: 'PENDING',
      });
      tx.rewardRedemption.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.adminReject('r1', 'out of stock');

      expect(result).toEqual({ rejected: true, refunded: 500 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(ledger.grant).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          coins: 500,
          reason: 'redemption_refund',
          key: 'redemption_refund:r1',
        }),
        tx,
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        'u1',
        'reward_rejected',
        expect.any(String),
        expect.stringContaining('out of stock'),
        { rewardId: 'airtime_500' },
      );
    });

    it('does not refund when the redemption was already resolved concurrently', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        rewardId: 'airtime_500',
        title: 'Airtime',
        coinCost: 500,
        status: 'PENDING',
      });
      tx.rewardRedemption.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.adminReject('r1')).rejects.toBeInstanceOf(BadRequestException);
      expect(ledger.grant).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('throws for an unknown redemption', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue(null);
      await expect(service.adminReject('ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
