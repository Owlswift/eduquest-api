import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RewardsService } from './rewards.service';

describe('RewardsService', () => {
  let prisma: any;
  let notifications: { notify: jest.Mock };
  let ledger: { spendCoins: jest.Mock; grant: jest.Mock };
  let audit: { log: jest.Mock };
  let tx: any;
  let service: RewardsService;

  const reward = (over: Record<string, unknown> = {}) => ({ id: 'airtime_500', title: 'Airtime', subtitle: 'N500', description: null, coinCost: 500, stock: null, active: true, kind: 'AIRTIME', imageKey: null, sortOrder: 1, ...over });
  const redemption = (over: Record<string, unknown> = {}) => ({ id: 'r1', userId: 'u1', rewardId: 'airtime_500', title: 'Airtime', coinCost: 500, status: 'PENDING', ...over });

  beforeEach(() => {
    tx = {
      reward: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue(reward()) },
      rewardRedemption: { create: jest.fn().mockResolvedValue({ id: 'r1' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      user: { findUnique: jest.fn() },
      reward: { findMany: jest.fn() },
      rewardRedemption: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
    };
    notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    ledger = { spendCoins: jest.fn().mockResolvedValue({ coins: 500 }), grant: jest.fn().mockResolvedValue({}) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new RewardsService(prisma, notifications as any, ledger as any, audit as any);
  });

  describe('list', () => {
    it('shows only active rewards, with affordability, stock and how many coins are still needed', async () => {
      prisma.user.findUnique.mockResolvedValue({ coins: 900 });
      prisma.reward.findMany.mockResolvedValue([
        reward(),
        reward({ id: 'laptop', title: 'Laptop', coinCost: 25000 }),
        reward({ id: 'books', title: 'Books', coinCost: 100, stock: 3 }),
        reward({ id: 'gone', title: 'Sold out', coinCost: 100, stock: 0 }),
      ]);

      const out = await service.list('u1');

      expect(prisma.reward.findMany.mock.calls[0][0].where).toEqual({ active: true });
      const by = Object.fromEntries(out.rewards.map((r) => [r.id, r]));
      expect(by.airtime_500).toMatchObject({ canAfford: true, inStock: true, stockLeft: null, coinsNeeded: 0 });
      expect(by.laptop).toMatchObject({ canAfford: false, coinsNeeded: 24100 });
      expect(by.books).toMatchObject({ canAfford: true, stockLeft: 3 }); // low stock is shown
      expect(by.gone).toMatchObject({ canAfford: false, inStock: false }); // can't afford what isn't there
      expect(out.coins).toBe(900);
    });

    it('treats a missing user as zero coins', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.reward.findMany.mockResolvedValue([reward()]);
      expect((await service.list('ghost')).rewards[0].canAfford).toBe(false);
    });
  });

  describe('redeem', () => {
    it('takes a unit of stock, records the price paid, debits coins and tells the student', async () => {
      const out = await service.redeem('u1', 'airtime_500');
      expect(tx.reward.updateMany).toHaveBeenCalledWith({
        where: { id: 'airtime_500', active: true, OR: [{ stock: null }, { stock: { gt: 0 } }] },
        data: { stock: { decrement: 1 } },
      });
      expect(tx.rewardRedemption.create).toHaveBeenCalledWith({ data: { userId: 'u1', rewardId: 'airtime_500', title: 'Airtime', coinCost: 500 } });
      expect(ledger.spendCoins).toHaveBeenCalledWith(expect.objectContaining({ coins: 500, key: 'redemption:r1' }), tx);
      expect(out).toEqual({ redeemed: true, coins: 500 });
      expect(notifications.notify).toHaveBeenCalledWith('u1', 'reward_redeemed', expect.any(String), expect.any(String), { rewardId: 'airtime_500' });
    });

    it.each([
      ['an unknown reward', null, NotFoundException, /Unknown/],
      ['an out-of-stock reward', { active: true }, BadRequestException, /out of stock/],
      ['a switched-off reward', { active: false }, BadRequestException, /no longer available/],
    ])('refuses %s without paying', async (_n, found, type, hint) => {
      tx.reward.updateMany.mockResolvedValue({ count: 0 });
      tx.reward.findUnique.mockResolvedValue(found);
      await expect(service.redeem('u1', 'x')).rejects.toBeInstanceOf(type as any);
      await expect(service.redeem('u1', 'x')).rejects.toThrow(hint as RegExp);
      expect(ledger.spendCoins).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('fails the whole redemption (stock included) when the coins are not there', async () => {
      ledger.spendCoins.mockRejectedValue(new BadRequestException('Not enough coins'));
      await expect(service.redeem('u1', 'airtime_500')).rejects.toBeInstanceOf(BadRequestException);
      expect(notifications.notify).not.toHaveBeenCalled(); // the transaction rolls back the stock and the record
    });
  });

  describe('cancel', () => {
    it('returns the coins and the unit of stock, once', async () => {
      prisma.rewardRedemption.findFirst.mockResolvedValue(redemption());
      const out = await service.cancel('u1', 'r1');
      expect(tx.rewardRedemption.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', status: { in: ['PENDING'] } }, data: expect.objectContaining({ status: 'CANCELLED' }) });
      expect(ledger.grant).toHaveBeenCalledWith(expect.objectContaining({ coins: 500, key: 'redemption_refund:r1' }), tx);
      expect(tx.reward.updateMany).toHaveBeenCalledWith({ where: { id: 'airtime_500', stock: { not: null } }, data: { stock: { increment: 1 } } });
      expect(out).toEqual({ cancelled: true, refunded: 500 });
    });

    it('only the owner can cancel, and only while it is pending', async () => {
      prisma.rewardRedemption.findFirst.mockResolvedValue(null);
      await expect(service.cancel('intruder', 'r1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.rewardRedemption.findFirst).toHaveBeenCalledWith({ where: { id: 'r1', userId: 'intruder' } });

      prisma.rewardRedemption.findFirst.mockResolvedValue(redemption({ status: 'APPROVED' }));
      tx.rewardRedemption.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancel('u1', 'r1')).rejects.toBeInstanceOf(ConflictException);
      expect(ledger.grant).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    it('reports status, closing note and whether it can still be cancelled', async () => {
      const createdAt = new Date('2026-06-01');
      prisma.rewardRedemption.findMany.mockResolvedValue([
        { ...redemption(), createdAt, fulfilledAt: null, closedAt: null, note: null },
        { ...redemption({ id: 'r2', status: 'REJECTED' }), createdAt, fulfilledAt: null, closedAt: createdAt, note: 'Out of stock' },
      ]);
      const out = await service.history('u1');
      expect(out[0]).toMatchObject({ id: 'r1', status: 'PENDING', redeemedAt: createdAt, canCancel: true });
      expect(out[1]).toMatchObject({ status: 'REJECTED', note: 'Out of stock', canCancel: false });
    });
  });

  describe('admin', () => {
    it('queues pending and approved redemptions with the student contact', async () => {
      prisma.rewardRedemption.findMany.mockResolvedValue([{ ...redemption({ status: 'APPROVED' }), createdAt: new Date(), approvedAt: new Date(), user: { fullName: 'ola law', email: 'ola@x.com', phone: '080' } }]);
      const out = await service.adminQueue();
      expect(prisma.rewardRedemption.findMany.mock.calls[0][0].where).toEqual({ status: { in: ['PENDING', 'APPROVED'] } });
      expect(out[0]).toMatchObject({ status: 'APPROVED', student: { fullName: 'ola law', email: 'ola@x.com', phone: '080' } });
    });

    it('approves only a pending redemption, audits it and tells the student', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue(redemption());
      await service.adminApprove('admin1', 'r1');
      expect(prisma.rewardRedemption.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', status: 'PENDING' }, data: expect.objectContaining({ status: 'APPROVED' }) });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'redemption.approve', adminId: 'admin1' }));
      expect(notifications.notify).toHaveBeenCalledWith('u1', 'reward_approved', expect.any(String), expect.any(String), expect.anything());

      prisma.rewardRedemption.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.adminApprove('admin1', 'r1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('fulfils a pending or approved redemption once, with the admin note', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue(redemption({ status: 'APPROVED' }));
      await expect(service.adminFulfill('admin1', 'r1', 'Sent via MTN')).resolves.toEqual({ fulfilled: true });
      expect(prisma.rewardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', status: { in: ['PENDING', 'APPROVED'] } },
        data: expect.objectContaining({ status: 'FULFILLED', note: 'Sent via MTN' }),
      });
      prisma.rewardRedemption.updateMany.mockResolvedValue({ count: 0 });
      notifications.notify.mockClear();
      await expect(service.adminFulfill('admin1', 'r1')).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('rejects with a refund and a restock, and tells the student why', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue(redemption());
      const out = await service.adminReject('admin1', 'r1', 'out of stock');
      expect(out).toEqual({ rejected: true, refunded: 500 });
      expect(ledger.grant).toHaveBeenCalledWith(expect.objectContaining({ coins: 500, key: 'redemption_refund:r1' }), tx);
      expect(tx.reward.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { stock: { increment: 1 } } }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'redemption.reject', summary: expect.stringContaining('out of stock') }));
      expect(notifications.notify).toHaveBeenCalledWith('u1', 'reward_rejected', expect.any(String), expect.stringContaining('out of stock'), expect.anything());
    });

    it('does not refund twice when the redemption is already closed', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue(redemption({ status: 'REJECTED' }));
      tx.rewardRedemption.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.adminReject('admin1', 'r1')).rejects.toBeInstanceOf(ConflictException);
      expect(ledger.grant).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('404s for an unknown redemption', async () => {
      prisma.rewardRedemption.findUnique.mockResolvedValue(null);
      await expect(service.adminFulfill('a', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.adminReject('a', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
