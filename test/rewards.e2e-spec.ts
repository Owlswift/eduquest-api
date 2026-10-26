/**
 * The rewards catalogue against a REAL Postgres: stock under contention,
 * refunds and restocking exactly once, and price changes not rewriting history.
 * Skipped unless TEST_DATABASE_URL points at a migrated, disposable database.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { AdminRewardsService } from '../src/modules/admin/admin-rewards.service';
import { AuditService } from '../src/modules/admin/audit.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { RewardsService } from '../src/modules/rewards/rewards.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('rewards catalogue (real database)', () => {
  let prisma: PrismaService;
  let rewards: RewardsService;
  let catalogue: AdminRewardsService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `rw${Date.now()}`;
  const userIds: string[] = [];
  const rewardIds: string[] = [];
  let adminId: string;
  let n = 0;

  const makeUser = async (coins = 0, over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `U ${n}`, username: id, email: `${id}@t.test`, coins, ...over } });
    if (coins > 0) await prisma.ledgerEntry.create({ data: { userId: id, currency: 'COIN', amount: coins, reason: 'seed', idempotencyKey: `seed:${id}` } });
    userIds.push(id);
    return id;
  };
  const makeReward = async (over: Record<string, unknown> = {}) => {
    const r = await catalogue.create(adminId, { title: `Prize ${++n}`, subtitle: 's', coinCost: 100, kind: 'OTHER', id: `${tag}_r${n}`, ...over } as any);
    rewardIds.push(r.id);
    return r.id;
  };
  const sums = async (id: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    const l = (await prisma.ledgerEntry.aggregate({ where: { userId: id, currency: 'COIN' }, _sum: { amount: true } }))._sum.amount ?? 0;
    return { coins: u.coins, ledger: l };
  };
  const stockOf = async (id: string) => (await prisma.reward.findUniqueOrThrow({ where: { id } })).stock;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    const audit = new AuditService(prisma);
    rewards = new RewardsService(prisma, { notify } as any, new LedgerService(prisma), audit);
    catalogue = new AdminRewardsService(prisma, audit);
    adminId = await makeUser(0, { role: 'ADMIN' });
  });

  afterAll(async () => {
    await prisma.rewardRedemption.deleteMany({ where: { rewardId: { in: rewardIds } } });
    await prisma.reward.deleteMany({ where: { id: { in: rewardIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { adminId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('serves the six seeded rewards, unlimited, in their original order', async () => {
    const u = await makeUser(1000);
    const { rewards: list } = await rewards.list(u);
    const seeded = list.filter((r) => !r.id.startsWith(tag));
    expect(seeded.map((r) => r.id)).toEqual(['airtime_500', 'data_1gb', 'edu_books', 'exam_voucher', 'laptop', 'scholarship']);
    expect(seeded.every((r) => r.inStock && r.stockLeft === null)).toBe(true);
    expect(seeded.find((r) => r.id === 'airtime_500')).toMatchObject({ canAfford: true, coinCost: 500 });
    expect(seeded.find((r) => r.id === 'laptop')).toMatchObject({ canAfford: false, coinsNeeded: 24000 });
  });

  describe('stock', () => {
    it('never sells more than is in stock, however many race for the last units', async () => {
      const id = await makeReward({ stock: 3 });
      const buyers = await Promise.all(Array.from({ length: 10 }, () => makeUser(100)));
      const attempts = await Promise.allSettled(buyers.map((u) => rewards.redeem(u, id)));

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(3);
      const failed = attempts.filter((a) => a.status === 'rejected') as PromiseRejectedResult[];
      expect(failed.every((f) => f.reason instanceof BadRequestException && /out of stock/.test(f.reason.message))).toBe(true);
      expect(await stockOf(id)).toBe(0);
      expect(await prisma.rewardRedemption.count({ where: { rewardId: id } })).toBe(3);

      // Whoever missed out was not charged.
      const results = await Promise.all(buyers.map(async (u) => ({ u, sums: await sums(u), got: (await prisma.rewardRedemption.count({ where: { userId: u } })) > 0 })));
      for (const r of results) {
        expect(r.sums.coins).toBe(r.got ? 0 : 100);
        expect(r.sums.coins).toBe(r.sums.ledger);
      }
    });

    it('does not take stock when the coins are not there', async () => {
      const id = await makeReward({ stock: 2, coinCost: 500 });
      const poor = await makeUser(10);
      await expect(rewards.redeem(poor, id)).rejects.toThrow(/Not enough coins/);
      expect(await stockOf(id)).toBe(2); // rolled back with the failed debit
      expect(await prisma.rewardRedemption.count({ where: { userId: poor } })).toBe(0);
    });

    it('leaves unlimited stock unlimited, and hides switched-off rewards', async () => {
      const id = await makeReward({ coinCost: 10 });
      const u = await makeUser(100);
      await rewards.redeem(u, id);
      expect(await stockOf(id)).toBeNull();
      await catalogue.update(adminId, id, { active: false });
      await expect(rewards.redeem(u, id)).rejects.toThrow(/no longer available/);
      expect((await rewards.list(u)).rewards.some((r) => r.id === id)).toBe(false);
    });
  });

  describe('cancelling and rejecting', () => {
    it('returns the coins and the unit once, however many cancel requests arrive', async () => {
      const id = await makeReward({ stock: 5, coinCost: 200 });
      const u = await makeUser(500);
      await rewards.redeem(u, id);
      const red = await prisma.rewardRedemption.findFirstOrThrow({ where: { userId: u } });
      expect(await stockOf(id)).toBe(4);

      const attempts = await Promise.allSettled([1, 2, 3, 4].map(() => rewards.cancel(u, red.id)));
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(await stockOf(id)).toBe(5); // back to 5, not 8
      const s = await sums(u);
      expect(s.coins).toBe(500);
      expect(s.ledger).toBe(500);
      expect((await rewards.history(u))[0]).toMatchObject({ status: 'CANCELLED', canCancel: false });
    });

    it('does not let a student cancel once an admin started on it, or someone else\'s request', async () => {
      const id = await makeReward({ coinCost: 50 });
      const u = await makeUser(100);
      const other = await makeUser(0);
      await rewards.redeem(u, id);
      const red = await prisma.rewardRedemption.findFirstOrThrow({ where: { userId: u } });
      await expect(rewards.cancel(other, red.id)).rejects.toThrow(/not found/i);
      await rewards.adminApprove(adminId, red.id);
      await expect(rewards.cancel(u, red.id)).rejects.toBeInstanceOf(ConflictException);
      expect((await sums(u)).coins).toBe(50);
    });

    it('moves PENDING -> APPROVED -> FULFILLED and is audited', async () => {
      const id = await makeReward({ coinCost: 30 });
      const u = await makeUser(100);
      await rewards.redeem(u, id);
      const red = await prisma.rewardRedemption.findFirstOrThrow({ where: { userId: u } });
      expect((await rewards.adminQueue()).find((q) => q.id === red.id)).toMatchObject({ status: 'PENDING' });
      await rewards.adminApprove(adminId, red.id);
      expect((await rewards.adminQueue()).find((q) => q.id === red.id)).toMatchObject({ status: 'APPROVED' });
      await expect(rewards.adminApprove(adminId, red.id)).rejects.toBeInstanceOf(ConflictException);
      await rewards.adminFulfill(adminId, red.id, 'Sent');
      expect((await rewards.adminQueue()).some((q) => q.id === red.id)).toBe(false);
      expect((await rewards.history(u))[0]).toMatchObject({ status: 'FULFILLED', note: 'Sent' });
      const actions = (await prisma.adminAuditLog.findMany({ where: { entityId: red.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['redemption.approve', 'redemption.fulfil']);
    });

    it('refunds and restocks exactly once when rejected, even if fulfil and reject collide', async () => {
      const id = await makeReward({ stock: 2, coinCost: 80 });
      const u = await makeUser(80);
      await rewards.redeem(u, id);
      const red = await prisma.rewardRedemption.findFirstOrThrow({ where: { userId: u } });
      const outcomes = await Promise.allSettled([rewards.adminReject(adminId, red.id, 'No stock'), rewards.adminReject(adminId, red.id, 'No stock'), rewards.adminFulfill(adminId, red.id)]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const final = (await prisma.rewardRedemption.findUniqueOrThrow({ where: { id: red.id } })).status;
      const s = await sums(u);
      if (final === 'REJECTED') {
        expect(s).toEqual({ coins: 80, ledger: 80 });
        expect(await stockOf(id)).toBe(2);
      } else {
        expect(s).toEqual({ coins: 0, ledger: 0 }); // delivered: coins stay spent, stock stays taken
        expect(await stockOf(id)).toBe(1);
      }
    });
  });

  describe('editing the catalogue', () => {
    it('does not rewrite what students already paid or were told', async () => {
      const id = await makeReward({ coinCost: 100, title: 'Old name' });
      const u = await makeUser(500);
      await rewards.redeem(u, id);
      await catalogue.update(adminId, id, { coinCost: 400, title: 'New name' });
      const h = (await rewards.history(u))[0];
      expect(h).toMatchObject({ title: 'Old name', coinCost: 100 });
      // A refund returns what was paid, not today's price.
      const red = await prisma.rewardRedemption.findFirstOrThrow({ where: { userId: u } });
      await rewards.adminReject(adminId, red.id);
      expect((await sums(u)).coins).toBe(500);
      // New purchases pay the new price.
      await rewards.redeem(u, id);
      expect((await sums(u)).coins).toBe(100);
    });

    it('deletes only a reward nobody has redeemed', async () => {
      const unused = await makeReward();
      await expect(catalogue.remove(adminId, unused)).resolves.toEqual({ deleted: true });
      expect(await prisma.reward.count({ where: { id: unused } })).toBe(0);
      const used = await makeReward({ coinCost: 5 });
      await rewards.redeem(await makeUser(10), used);
      await expect(catalogue.remove(adminId, used)).rejects.toThrow(/Switch the reward off/);
    });
  });
});
