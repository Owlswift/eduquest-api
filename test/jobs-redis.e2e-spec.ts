/**
 * The BullMQ wiring against a REAL Redis: schedules are registered once (not
 * duplicated by a restart), a queued job reaches the worker, and shutdown is
 * clean. Skipped unless TEST_REDIS_URL is set.
 */
import { Queue } from 'bullmq';
import { JobsService, redisConnection, TASKS } from '../src/modules/jobs/jobs.service';

const url = process.env.TEST_REDIS_URL;
const d = url ? describe : describe.skip;

d('scheduled jobs (real Redis)', () => {
  const tasks = {
    advanceCompetitions: jest.fn().mockResolvedValue({ advanced: 0 }),
    dailyChallengeReady: jest.fn().mockResolvedValue({ sent: 0 }),
    streakReminders: jest.fn().mockResolvedValue({ sent: 7 }),
    prizeClaimReminders: jest.fn().mockResolvedValue({ sent: 0 }),
  };
  const started: JobsService[] = [];

  const start = async () => {
    process.env.REDIS_URL = url;
    const jobs = new JobsService(tasks as any);
    await jobs.onModuleInit();
    started.push(jobs);
    return jobs;
  };

  afterAll(async () => {
    for (const j of started) await j.onModuleDestroy();
    const q = new Queue('eduquest-scheduled', { connection: redisConnection(url!) });
    await q.obliterate({ force: true });
    await q.close();
  });

  it('registers one schedule per task, and a second instance does not duplicate them', async () => {
    const a = await start();
    const b = await start(); // e.g. a second API instance, or a restart
    expect(a.enabled && b.enabled).toBe(true);
    const q = new Queue('eduquest-scheduled', { connection: redisConnection(url!) });
    const schedulers = await q.getJobSchedulers();
    expect(schedulers.map((s) => s.key).sort()).toEqual(TASKS.map((t) => t.name).sort());
    const streak = schedulers.find((s) => s.key === 'streak-reminder')!;
    expect(streak).toMatchObject({ pattern: '0 18 * * *', tz: 'Africa/Lagos' });
    expect(schedulers.find((s) => s.key === 'competitions-tick')).toMatchObject({ every: 300000 });
    await q.close();
  });

  it('runs a queued job on the worker', async () => {
    const jobs = await start();
    await jobs.enqueue('streak-reminder');
    for (let i = 0; i < 50 && tasks.streakReminders.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(tasks.streakReminders).toHaveBeenCalled();
  });

  it('refuses to queue an unknown task', async () => {
    expect(await (await start()).enqueue('not-a-task')).toBeNull();
  });
});
