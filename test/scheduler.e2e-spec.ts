/**
 * The in-process scheduler (no Redis) against a real database: each slot runs
 * once even with several instances ticking at once, a failed run is retried,
 * and a restart does not repeat a slot that already ran.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { JobsService, TASKS } from '../src/modules/jobs/jobs.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('in-process scheduler (real database)', () => {
  let prisma: PrismaClient;
  const mkTasks = () => ({
    advanceCompetitions: jest.fn().mockResolvedValue({}),
    dailyChallengeReady: jest.fn().mockResolvedValue({}),
    streakReminders: jest.fn().mockResolvedValue({}),
    prizeClaimReminders: jest.fn().mockResolvedValue({}),
  });
  const calls = (t: ReturnType<typeof mkTasks>) => Object.values(t).reduce((n, f) => n + f.mock.calls.length, 0);
  // 12:03 Lagos: the 5-minute task is due; the 07:00 and 09:00 daily slots are more than 3h old.
  const NOON = new Date('2026-03-02T11:03:00Z');

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  });
  beforeEach(() => prisma.scheduledRun.deleteMany());
  afterAll(() => prisma.$disconnect());

  it('runs a due slot once across several instances ticking at the same moment', async () => {
    const t = mkTasks();
    const instances = [1, 2, 3, 4].map(() => new JobsService(t as any, prisma as any));
    await Promise.all(instances.map((j) => j.tick(NOON)));
    expect(t.advanceCompetitions).toHaveBeenCalledTimes(1);
    expect(await prisma.scheduledRun.count({ where: { task: 'competitions-tick' } })).toBe(1);
  });

  it('does not repeat a slot after a restart, but runs the next one', async () => {
    const t = mkTasks();
    await new JobsService(t as any, prisma as any).tick(NOON);
    await new JobsService(t as any, prisma as any).tick(new Date(NOON.getTime() + 60_000));
    expect(t.advanceCompetitions).toHaveBeenCalledTimes(1);
    await new JobsService(t as any, prisma as any).tick(new Date(NOON.getTime() + 5 * 60_000));
    expect(t.advanceCompetitions).toHaveBeenCalledTimes(2);
  });

  it('catches up a daily task shortly after its time, and skips it when far too late', async () => {
    const t = mkTasks();
    await new JobsService(t as any, prisma as any).tick(new Date('2026-03-02T06:40:00Z')); // 07:40 Lagos
    expect(t.dailyChallengeReady).toHaveBeenCalledTimes(1);
    const late = mkTasks();
    await new JobsService(late as any, prisma as any).tick(new Date('2026-03-02T12:00:00Z')); // 13:00 Lagos
    expect(late.dailyChallengeReady).not.toHaveBeenCalled();
    expect(late.prizeClaimReminders).not.toHaveBeenCalled(); // 09:00 slot is 4h old
  });

  it('releases a failed run so the next tick retries it, without stopping other tasks', async () => {
    const t = mkTasks();
    t.advanceCompetitions.mockRejectedValueOnce(new Error('boom'));
    const j = new JobsService(t as any, prisma as any);
    const first = await j.tick(NOON);
    expect(first.ran).not.toContain('competitions-tick');
    expect(await prisma.scheduledRun.count({ where: { task: 'competitions-tick' } })).toBe(0);
    const second = await j.tick(new Date(NOON.getTime() + 30_000));
    expect(second.ran).toContain('competitions-tick');
    expect(t.advanceCompetitions).toHaveBeenCalledTimes(2);
  });

  it('starts itself on init without Redis, reports it, and is off when disabled', async () => {
    delete process.env.REDIS_URL;
    const t = mkTasks();
    const on = new JobsService(t as any, prisma as any);
    await on.onModuleInit();
    expect(on.enabled).toBe(true);
    expect(on.describe().scheduler).toBe('running (in-process)');
    await on.onModuleDestroy();
    expect(on.enabled).toBe(false);

    process.env.DISABLE_SCHEDULER = 'true';
    const off = new JobsService(t as any, prisma as any);
    await off.onModuleInit();
    delete process.env.DISABLE_SCHEDULER;
    expect(off.enabled).toBe(false);
    expect(off.describe().scheduler).toMatch(/off/);
    expect(TASKS.length).toBeGreaterThan(0);
  });
});
