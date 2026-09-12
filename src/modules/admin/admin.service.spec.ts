import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  let prisma: {
    user: { count: jest.Mock; aggregate: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    rewardRedemption: { count: jest.Mock };
    competition: { count: jest.Mock };
    certificate: { count: jest.Mock };
  };
  let service: AdminService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
    prisma = {
      user: {
        count: jest.fn(),
        aggregate: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      rewardRedemption: { count: jest.fn() },
      competition: { count: jest.fn() },
      certificate: { count: jest.fn() },
    };
    service = new AdminService(prisma as any);
  });

  afterEach(() => jest.useRealTimers());

  describe('overview', () => {
    it('aggregates every stat in one shape', async () => {
      prisma.user.count
        .mockResolvedValueOnce(120) // totalStudents
        .mockResolvedValueOnce(2) // totalAdmins
        .mockResolvedValueOnce(5); // newUsersLast7Days
      prisma.user.aggregate.mockResolvedValue({ _sum: { coins: 5000, xp: 12000 } });
      prisma.rewardRedemption.count.mockResolvedValue(3);
      prisma.competition.count.mockResolvedValue(1);
      prisma.certificate.count.mockResolvedValue(8);

      const result = await service.overview();

      expect(result).toEqual({
        totalStudents: 120,
        totalAdmins: 2,
        totalCoinsInCirculation: 5000,
        totalXpInCirculation: 12000,
        pendingRedemptions: 3,
        activeCompetitions: 1,
        newUsersLast7Days: 5,
        certificatesAwarded: 8,
      });
    });

    it('defaults sums to 0 when there are no users at all', async () => {
      prisma.user.count.mockResolvedValue(0);
      prisma.user.aggregate.mockResolvedValue({ _sum: { coins: null, xp: null } });
      prisma.rewardRedemption.count.mockResolvedValue(0);
      prisma.competition.count.mockResolvedValue(0);
      prisma.certificate.count.mockResolvedValue(0);

      const result = await service.overview();

      expect(result.totalCoinsInCirculation).toBe(0);
      expect(result.totalXpInCirculation).toBe(0);
    });
  });

  describe('listUsers', () => {
    it('paginates and returns the total count', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
      prisma.user.count.mockResolvedValue(50);

      const result = await service.listUsers(undefined, 2, 20);

      expect(result).toEqual({ users: [{ id: 'u1' }], total: 50, page: 2, limit: 20 });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20, where: {} }),
      );
    });

    it('searches by name/username/email case-insensitively', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.listUsers('ola', 1, 20);

      const arg = prisma.user.findMany.mock.calls[0][0];
      expect(arg.where.OR).toEqual([
        { fullName: { contains: 'ola', mode: 'insensitive' } },
        { username: { contains: 'ola', mode: 'insensitive' } },
        { email: { contains: 'ola', mode: 'insensitive' } },
      ]);
    });
  });

  describe('getUser', () => {
    it('returns full detail for an existing user', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', fullName: 'ola law' });
      const result = await service.getUser('u1');
      expect(result).toEqual({ id: 'u1', fullName: 'ola law' });
    });

    it('throws for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getUser('ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateUserRole', () => {
    it('promotes a different user', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.user.update.mockResolvedValue({ id: 'u2', fullName: 'x', role: 'ADMIN' });

      const result = await service.updateUserRole('admin1', 'u2', 'ADMIN' as any);

      expect(result.role).toBe('ADMIN');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u2' },
        data: { role: 'ADMIN' },
        select: { id: true, fullName: true, role: true },
      });
    });

    it('refuses to let an admin change their own role', async () => {
      await expect(
        service.updateUserRole('admin1', 'admin1', 'STUDENT' as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('throws for an unknown target user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.updateUserRole('admin1', 'ghost', 'ADMIN' as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
