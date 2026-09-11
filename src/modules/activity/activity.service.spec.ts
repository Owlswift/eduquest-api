import { ActivityService } from './activity.service';

/** UTC-midnight Date for a Y-M-D (month is 1-based here for readability). */
const day = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));

describe('ActivityService', () => {
  let prisma: {
    dailyActivity: { findMany: jest.Mock; upsert: jest.Mock };
    user: { update: jest.Mock; findUnique: jest.Mock };
  };
  let service: ActivityService;

  beforeEach(() => {
    // Pin "now" to Wed 17 Jun 2026, 10:00 UTC (12:00 in Lagos, same date).
    jest.useFakeTimers().setSystemTime(new Date('2026-06-17T10:00:00Z'));
    prisma = {
      dailyActivity: { findMany: jest.fn(), upsert: jest.fn() },
      user: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn() },
    };
    service = new ActivityService(prisma as any);
  });

  afterEach(() => jest.useRealTimers());

  describe('recomputeStreak', () => {
    it('counts consecutive active days ending today', async () => {
      prisma.dailyActivity.findMany.mockResolvedValue([
        { date: day(2026, 6, 17) },
        { date: day(2026, 6, 16) },
        { date: day(2026, 6, 15) },
      ]);

      const streak = await service.recomputeStreak('u1');

      expect(streak).toBe(3);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { streak: 3 },
      });
    });

    it('still counts the run when today has no activity yet', async () => {
      prisma.dailyActivity.findMany.mockResolvedValue([
        { date: day(2026, 6, 16) },
        { date: day(2026, 6, 15) },
      ]);

      expect(await service.recomputeStreak('u1')).toBe(2);
    });

    it('stops at the first gap', async () => {
      prisma.dailyActivity.findMany.mockResolvedValue([
        { date: day(2026, 6, 17) },
        // 16th missing
        { date: day(2026, 6, 15) },
        { date: day(2026, 6, 14) },
      ]);

      expect(await service.recomputeStreak('u1')).toBe(1);
    });

    it('is 0 when there is no recent activity', async () => {
      prisma.dailyActivity.findMany.mockResolvedValue([]);
      expect(await service.recomputeStreak('u1')).toBe(0);
    });
  });

  describe('getDailySummary', () => {
    it('builds the Mon-Sun strip and today\'s goal progress', async () => {
      prisma.dailyActivity.findMany.mockResolvedValue([
        { date: day(2026, 6, 15), questionsAnswered: 5, lessonsStudied: 0 }, // Mon
        { date: day(2026, 6, 16), questionsAnswered: 0, lessonsStudied: 2 }, // Tue
        { date: day(2026, 6, 17), questionsAnswered: 10, lessonsStudied: 0 }, // Wed (today)
      ]);
      prisma.user.findUnique.mockResolvedValue({ streak: 3 });

      const summary = await service.getDailySummary('u1');

      expect(summary.streak).toBe(3);
      expect(summary.week.map((d) => d.weekday)).toEqual([
        'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
      ]);
      expect(summary.week.find((d) => d.isToday)?.weekday).toBe('Wed');
      expect(summary.week.filter((d) => d.studied).map((d) => d.weekday)).toEqual([
        'Mon', 'Tue', 'Wed',
      ]);
      // 10 answered today, goal 20 -> 50%
      expect(summary.goal).toEqual({
        target: 20,
        answeredToday: 10,
        percent: 50,
      });
    });

    it('reports zero progress when nothing was done today', async () => {
      prisma.dailyActivity.findMany.mockResolvedValue([]);
      prisma.user.findUnique.mockResolvedValue({ streak: 0 });

      const summary = await service.getDailySummary('u1');

      expect(summary.goal.answeredToday).toBe(0);
      expect(summary.goal.percent).toBe(0);
      expect(summary.week.every((d) => !d.studied)).toBe(true);
    });
  });

  describe('recordQuestions', () => {
    it('is a no-op for a non-positive count', async () => {
      await service.recordQuestions('u1', 0);
      expect(prisma.dailyActivity.upsert).not.toHaveBeenCalled();
    });

    it('upserts today\'s row and recomputes the streak', async () => {
      prisma.dailyActivity.upsert.mockResolvedValue({});
      prisma.dailyActivity.findMany.mockResolvedValue([{ date: day(2026, 6, 17) }]);

      await service.recordQuestions('u1', 4);

      expect(prisma.dailyActivity.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.dailyActivity.upsert.mock.calls[0][0];
      expect(arg.where.userId_date.userId).toBe('u1');
      expect(arg.create.questionsAnswered).toBe(4);
      expect(arg.update.questionsAnswered).toEqual({ increment: 4 });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { streak: 1 },
      });
    });
  });
});
