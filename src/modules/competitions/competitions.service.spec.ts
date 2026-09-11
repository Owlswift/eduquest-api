import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CompetitionsService } from './competitions.service';

describe('CompetitionsService', () => {
  let prisma: {
    competition: { findMany: jest.Mock; findUnique: jest.Mock };
    competitionParticipant: { findMany: jest.Mock; upsert: jest.Mock; findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
    dailyActivity: { aggregate: jest.Mock };
  };
  let notifications: { notify: jest.Mock };
  let service: CompetitionsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
    prisma = {
      competition: { findMany: jest.fn(), findUnique: jest.fn() },
      competitionParticipant: { findMany: jest.fn(), upsert: jest.fn(), findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
      dailyActivity: { aggregate: jest.fn() },
    };
    notifications = { notify: jest.fn() };
    service = new CompetitionsService(prisma as any, notifications as any);
  });

  afterEach(() => jest.useRealTimers());

  describe('list', () => {
    it('marks status, participant count, and join state', async () => {
      prisma.competition.findMany.mockResolvedValue([
        {
          id: 'c1',
          title: 'Ongoing',
          subtitle: '',
          prizes: [],
          startsAt: new Date('2026-06-10'),
          endsAt: new Date('2026-06-20'),
          _count: { participants: 3 },
        },
        {
          id: 'c2',
          title: 'Upcoming',
          subtitle: '',
          prizes: [],
          startsAt: new Date('2026-07-01'),
          endsAt: new Date('2026-07-10'),
          _count: { participants: 0 },
        },
        {
          id: 'c3',
          title: 'Ended',
          subtitle: '',
          prizes: [],
          startsAt: new Date('2026-05-01'),
          endsAt: new Date('2026-05-10'),
          _count: { participants: 5 },
        },
      ]);
      prisma.competitionParticipant.findMany.mockResolvedValue([{ competitionId: 'c1' }]);

      const result = await service.list('me');

      expect(result.map((c) => c.status)).toEqual(['ongoing', 'upcoming', 'ended']);
      expect(result[0].isJoined).toBe(true);
      expect(result[0].participantCount).toBe(3);
      expect(result[1].isJoined).toBe(false);
    });
  });

  describe('join', () => {
    it('snapshots current XP, upserts idempotently, and notifies on first join', async () => {
      prisma.competition.findUnique.mockResolvedValue({
        id: 'c1',
        title: 'Monthly Challenge',
        endsAt: new Date('2026-06-20'),
      });
      prisma.competitionParticipant.findUnique.mockResolvedValue(null); // not joined yet
      prisma.user.findUnique.mockResolvedValue({ xp: 250 });
      prisma.competitionParticipant.upsert.mockResolvedValue({});

      const result = await service.join('u1', 'c1');

      expect(result).toEqual({ joined: true });
      const arg = prisma.competitionParticipant.upsert.mock.calls[0][0];
      expect(arg.create).toEqual({ competitionId: 'c1', userId: 'u1', xpAtJoin: 250 });
      expect(notifications.notify).toHaveBeenCalledWith(
        'u1',
        'competition_joined',
        expect.any(String),
        expect.stringContaining('Monthly Challenge'),
        { competitionId: 'c1' },
      );
    });

    it('does not re-notify when already joined (idempotent re-join)', async () => {
      prisma.competition.findUnique.mockResolvedValue({
        id: 'c1',
        title: 'Monthly Challenge',
        endsAt: new Date('2026-06-20'),
      });
      prisma.competitionParticipant.findUnique.mockResolvedValue({ id: 'existing' });
      prisma.user.findUnique.mockResolvedValue({ xp: 250 });
      prisma.competitionParticipant.upsert.mockResolvedValue({});

      await service.join('u1', 'c1');

      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('rejects joining after the competition has ended', async () => {
      prisma.competition.findUnique.mockResolvedValue({
        id: 'c1',
        endsAt: new Date('2026-06-01'), // before the pinned "now"
      });

      await expect(service.join('u1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.competitionParticipant.upsert).not.toHaveBeenCalled();
    });

    it('throws for an unknown competition', async () => {
      prisma.competition.findUnique.mockResolvedValue(null);
      await expect(service.join('u1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('leaderboard', () => {
    it('ranks by XP earned during the competition window (per DailyActivity), not lifetime total', async () => {
      prisma.competition.findUnique.mockResolvedValue({
        id: 'c1',
        startsAt: new Date('2026-06-10T00:00:00Z'),
        endsAt: new Date('2026-06-20T00:00:00Z'),
      });
      prisma.competitionParticipant.findMany.mockResolvedValue([
        { userId: 'a', joinedAt: new Date('2026-06-12T00:00:00Z'), user: { id: 'a', fullName: 'Aisha Bello' } },
        { userId: 'me', joinedAt: new Date('2026-06-11T00:00:00Z'), user: { id: 'me', fullName: 'ola law' } },
      ]);
      prisma.dailyActivity.aggregate.mockImplementation(({ where }: any) =>
        Promise.resolve({ _sum: { xpEarned: where.userId === 'a' ? 20 : 80 } }),
      );

      const result = await service.leaderboard('me', 'c1');

      expect(result.top).toEqual([
        { rank: 1, userId: 'me', name: 'Ola', xpEarned: 80, isMe: true },
        { rank: 2, userId: 'a', name: 'Aisha', xpEarned: 20, isMe: false },
      ]);
      expect(result.me?.rank).toBe(1);
    });

    it('excludes XP earned before the competition started, even for an early joiner', async () => {
      prisma.competition.findUnique.mockResolvedValue({
        id: 'c1',
        startsAt: new Date('2026-06-10T00:00:00Z'),
        endsAt: new Date('2026-06-20T00:00:00Z'),
      });
      prisma.competitionParticipant.findMany.mockResolvedValue([
        {
          userId: 'early',
          joinedAt: new Date('2026-06-01T00:00:00Z'), // joined 9 days before it started
          user: { id: 'early', fullName: 'early bird' },
        },
      ]);
      prisma.dailyActivity.aggregate.mockResolvedValue({ _sum: { xpEarned: 999 } });

      await service.leaderboard('early', 'c1');

      const arg = prisma.dailyActivity.aggregate.mock.calls[0][0];
      // The scoring window is clamped to startsAt, not the earlier joinedAt -
      // XP earned in the 9 days before the competition began doesn't count.
      expect(arg.where.date.gte.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    });

    it('returns an empty leaderboard when nobody has joined', async () => {
      prisma.competition.findUnique.mockResolvedValue({
        id: 'c1',
        startsAt: new Date('2026-06-01T00:00:00Z'),
        endsAt: new Date('2026-06-20T00:00:00Z'),
      });
      prisma.competitionParticipant.findMany.mockResolvedValue([]);

      const result = await service.leaderboard('me', 'c1');

      expect(result).toEqual({ top: [], me: null });
      expect(prisma.dailyActivity.aggregate).not.toHaveBeenCalled();
    });
  });
});
