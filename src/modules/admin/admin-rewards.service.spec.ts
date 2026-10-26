import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { AdminRewardsService } from './admin-rewards.service';

describe('AdminRewardsService', () => {
  let prisma: any;
  let audit: { log: jest.Mock };
  let service: AdminRewardsService;
  const row = (over: Record<string, unknown> = {}) => ({ id: 'data_1gb', title: 'Data', subtitle: '1GB', description: null, coinCost: 800, stock: null, active: true, kind: 'DATA', imageKey: null, sortOrder: 2, ...over });

  beforeEach(() => {
    prisma = {
      reward: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      rewardRedemption: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new AdminRewardsService(prisma, audit as any);
  });

  it('lists rewards, switched-off ones included, with redemption counts', async () => {
    prisma.reward.findMany.mockResolvedValue([row(), row({ id: 'old', active: false })]);
    prisma.rewardRedemption.groupBy.mockResolvedValue([
      { rewardId: 'data_1gb', status: 'PENDING', _count: { _all: 2 } },
      { rewardId: 'data_1gb', status: 'FULFILLED', _count: { _all: 5 } },
    ]);
    const out = await service.list();
    expect(out[0]).toMatchObject({ id: 'data_1gb', redemptions: 7, openRedemptions: 2 });
    expect(out[1]).toMatchObject({ id: 'old', active: false, redemptions: 0 });
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.reward.findUnique.mockResolvedValue(null);
      prisma.reward.create.mockImplementation(({ data }: any) => Promise.resolve(row(data)));
    });

    it('makes an id from the title, defaults to unlimited and active, and audits it', async () => {
      const out = await service.create('admin1', { title: ' Data Bundle 2GB! ', subtitle: '2GB', coinCost: 1500, kind: 'DATA' } as any);
      expect(prisma.reward.create.mock.calls[0][0].data).toMatchObject({ id: 'data_bundle_2gb', title: 'Data Bundle 2GB!', stock: null, active: true });
      expect(out.id).toBe('data_bundle_2gb');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'reward.create', adminId: 'admin1' }));
    });

    it('refuses a duplicate id and a title with nothing usable for an id', async () => {
      prisma.reward.findUnique.mockResolvedValue(row());
      await expect(service.create('a', { id: 'data_1gb', title: 'x', subtitle: 's', coinCost: 1, kind: 'DATA' } as any)).rejects.toBeInstanceOf(ConflictException);
      prisma.reward.findUnique.mockResolvedValue(null);
      await expect(service.create('a', { title: '!!', subtitle: 's', coinCost: 1, kind: 'DATA' } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('records a price change in the audit summary, and can make stock unlimited again', async () => {
      prisma.reward.findUnique.mockResolvedValue(row({ stock: 4 }));
      prisma.reward.update.mockResolvedValue(row({ coinCost: 900, stock: null }));
      await service.update('admin1', 'data_1gb', { coinCost: 900, stock: null });
      expect(prisma.reward.update).toHaveBeenCalledWith({ where: { id: 'data_1gb' }, data: { coinCost: 900, stock: null } });
      expect(audit.log.mock.calls[0][0].summary).toMatch(/price 800 to 900/);
    });

    it('rejects an empty change and an unknown reward', async () => {
      prisma.reward.findUnique.mockResolvedValue(row());
      await expect(service.update('a', 'data_1gb', {})).rejects.toBeInstanceOf(BadRequestException);
      prisma.reward.findUnique.mockResolvedValue(null);
      await expect(service.update('a', 'ghost', { title: 'xx' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('deletes only a reward nobody redeemed', async () => {
    prisma.reward.findUnique.mockResolvedValue(row());
    await expect(service.remove('a', 'data_1gb')).resolves.toEqual({ deleted: true });
    prisma.rewardRedemption.count.mockResolvedValue(3);
    await expect(service.remove('a', 'data_1gb')).rejects.toThrow(/Switch the reward off/);
  });
});
