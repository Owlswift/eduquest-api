import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';
import { BOARD_TTL_SEC, LeaderboardsService } from './leaderboards.service';

describe('LeaderboardsService', () => {
  let prisma: any;
  let cache: CacheService;
  let service: LeaderboardsService;
  const me = { state: 'Lagos', classLevel: 'SS2', subjects: '["math","english"]' };
  const row = (over: Record<string, unknown> = {}) => ({ id: 'u1', fullName: 'ada nwosu', state: 'Lagos', classLevel: 'SS2', score: 900, answered: null, rank: 1, ...over });

  beforeEach(() => {
    delete process.env.REDIS_URL;
    cache = new CacheService();
    prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue(me) },
      subject: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([{ id: 'math', name: 'Mathematics' }, { id: 'english', name: 'English' }, { id: 'bio', name: 'Biology' }]) },
      $queryRaw: jest.fn(),
    };
    service = new LeaderboardsService(prisma, cache);
  });

  const mockBoard = (top: unknown[], mine: unknown[] = []) => prisma.$queryRaw.mockResolvedValueOnce(top).mockResolvedValueOnce(mine);

  describe('what each board says it ranks', () => {
    it.each([
      [{ scope: 'national', period: 'all' }, 'Lifetime XP · Nigeria'],
      [{ scope: 'national', period: 'weekly' }, 'XP this week · Nigeria'],
      [{ scope: 'state', period: 'monthly' }, 'XP this month · Lagos'],
      [{ scope: 'region', period: 'all' }, 'Lifetime XP · South West'],
      [{ scope: 'class', period: 'all' }, 'Lifetime XP · SS2 students'],
    ])('%j is titled "%s"', async (q: any, title) => {
      mockBoard([row()]);
      expect((await service.board('u1', { limit: 20, ...q })).title).toBe(title);
    });

    it('titles a subject board by subject and period, and names its minimum', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      mockBoard([row({ answered: 40, score: 30 })]);
      const out = await service.board('u1', { scope: 'class', period: 'weekly', subjectId: 'math', limit: 20 });
      expect(out.title).toBe('Correct answers in Mathematics, this week · SS2 students');
      expect(out.metric.key).toBe('correct_answers');
      expect(out.minSubjectAnswers).toBe(20);
      expect(out.entries[0]).toMatchObject({ score: 30, accuracy: 75 });
    });
  });

  describe('scope', () => {
    it('defaults to the viewer\'s own state, zone and class, and honours overrides', async () => {
      mockBoard([row()]);
      expect((await service.board('u1', { scope: 'state', period: 'all', state: 'kano', limit: 5 })).scope).toEqual({ type: 'state', label: 'Kano' });
      mockBoard([row()]);
      expect((await service.board('u1', { scope: 'region', period: 'all', region: 'NORTH_WEST' as any, limit: 5 })).scope.label).toBe('North West');
      mockBoard([row()]);
      expect((await service.board('u1', { scope: 'class', period: 'all', classLevel: 'SS3' as any, limit: 5 })).scope.label).toBe('SS3 students');
    });

    it('asks a student with no state to set one, and rejects a non-state', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ ...me, state: null });
      await expect(service.board('u1', { scope: 'state', period: 'all', limit: 5 })).rejects.toThrow(/Set your state/);
      await expect(service.board('u1', { scope: 'region', period: 'all', limit: 5 })).rejects.toThrow(/Set your state/);
      await expect(service.board('u1', { scope: 'state', period: 'all', state: 'Narnia', limit: 5 })).rejects.toBeInstanceOf(BadRequestException);
      mockBoard([]);
      await expect(service.board('u1', { scope: 'national', period: 'all', limit: 5 })).resolves.toBeDefined(); // national needs no state
    });

    it('404s for an unknown subject', async () => {
      prisma.subject.findUnique.mockResolvedValue(null);
      await expect(service.board('u1', { scope: 'national', period: 'all', subjectId: 'ghost', limit: 5 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('entries', () => {
    it('shows a first name and surname initial, marks the viewer, and never leaks contact details', async () => {
      mockBoard([row(), row({ id: 'u2', fullName: 'chinedu okafor', score: 800, rank: 2 })]);
      const out = await service.board('u1', { scope: 'national', period: 'all', limit: 20 });
      expect(out.entries.map((e) => [e.rank, e.name, e.isMe])).toEqual([[1, 'Ada N.', true], [2, 'Chinedu O.', false]]);
      expect(JSON.stringify(out)).not.toMatch(/email|phone|@/);
    });

    it('reports the viewer\'s own position separately, including when they are below the top', async () => {
      mockBoard([row({ id: 'u9', fullName: 'zainab a', score: 5000 })], [{ score: 120, answered: null, rank: 431, fullName: 'ada nwosu' }]);
      const out = await service.board('u1', { scope: 'national', period: 'all', limit: 20 });
      expect(out.entries.some((e) => e.isMe)).toBe(false);
      expect(out.me).toEqual({ rank: 431, name: 'Ada N.', score: 120, accuracy: null });
    });

    it('has no "me" for a student who is not on the board', async () => {
      mockBoard([row({ id: 'u9' })], []);
      expect((await service.board('u1', { scope: 'national', period: 'weekly', limit: 20 })).me).toBeNull();
    });
  });

  describe('caching', () => {
    it('reuses the top of a board for a minute but always reads the viewer fresh', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-15T10:00:00Z'));
      prisma.$queryRaw
        .mockResolvedValueOnce([row()]) // top
        .mockResolvedValueOnce([{ score: 10, answered: null, rank: 5, fullName: 'ada' }]) // me
        .mockResolvedValueOnce([{ score: 20, answered: null, rank: 3, fullName: 'ada' }]); // me, second time

      const first = await service.board('u1', { scope: 'national', period: 'all', limit: 20 });
      const second = await service.board('u1', { scope: 'national', period: 'all', limit: 20 });

      expect([first.cached, second.cached]).toEqual([false, true]);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3); // one top query, two "me" queries
      expect(second.me!.rank).toBe(3);

      jest.setSystemTime(new Date(Date.now() + (BOARD_TTL_SEC + 1) * 1000));
      prisma.$queryRaw.mockResolvedValue([]);
      expect((await service.board('u1', { scope: 'national', period: 'all', limit: 20 })).cached).toBe(false);
      jest.useRealTimers();
    });

    it('keeps different boards apart', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await service.board('u1', { scope: 'national', period: 'all', limit: 20 });
      const other = await service.board('u1', { scope: 'national', period: 'weekly', limit: 20 });
      expect(other.cached).toBe(false);
    });
  });

  it('lists the boards a student can open, with their own place filled in', async () => {
    const o = await service.options('u1');
    expect(o.scopes).toEqual([
      { id: 'national', label: 'Nigeria' },
      { id: 'state', label: 'Lagos', value: 'Lagos' },
      { id: 'region', label: 'South West', value: 'SOUTH_WEST' },
      { id: 'class', label: 'SS2 students', value: 'SS2' },
    ]);
    expect(o.periods.map((p) => p.id)).toEqual(['all', 'weekly', 'monthly']);
    expect(o.subjects.filter((s) => s.mine).map((s) => s.id)).toEqual(['math', 'english']);
    expect(o.regions).toHaveLength(6);
  });

  it('omits the boards a student without a state cannot open', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ state: null, classLevel: 'SS1', subjects: null });
    expect((await service.options('u1')).scopes.map((s) => s.id)).toEqual(['national', 'class']);
  });

  it('keeps the original response shape for older clients', async () => {
    mockBoard([row(), row({ id: 'u2', fullName: 'tunde b', score: 700, rank: 2 })], [{ score: 900, answered: null, rank: 1, fullName: 'ada nwosu' }]);
    expect(await service.legacy('u1', 'all', 20)).toEqual({
      top: [{ rank: 1, name: 'Ada N.', xp: 900, isMe: true }, { rank: 2, name: 'Tunde B.', xp: 700, isMe: false }],
      me: { rank: 1, name: 'Ada N.', xp: 900 },
    });
  });
});
