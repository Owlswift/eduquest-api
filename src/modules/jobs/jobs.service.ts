import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { latestSlot } from './schedule-slots';
import { ScheduledTasksService } from './scheduled-tasks.service';

export interface TaskDefinition {
  name: string;
  description: string;
  /** Either a fixed interval or a cron pattern evaluated in Lagos time. */
  schedule: { everyMs: number } | { pattern: string };
  run: (tasks: ScheduledTasksService) => Promise<unknown>;
}

export const TASKS: TaskDefinition[] = [
  { name: 'competitions-tick', description: 'Open and close competitions on time; announce openings and closing soon', schedule: { everyMs: 5 * 60_000 }, run: (t) => t.advanceCompetitions() },
  { name: 'daily-challenge-ready', description: 'Morning prompt that today’s daily challenge is ready', schedule: { pattern: '0 7 * * *' }, run: (t) => t.dailyChallengeReady() },
  { name: 'streak-reminder', description: 'Evening nudge for students about to lose a streak', schedule: { pattern: '0 18 * * *' }, run: (t) => t.streakReminders() },
  { name: 'purge-expired-tokens', description: 'Delete expired sign-in tokens', schedule: { pattern: '0 3 * * *' }, run: (t) => t.purgeExpiredTokens() },
  { name: 'prize-claim-reminders', description: 'Remind winners to claim before the deadline', schedule: { pattern: '0 9 * * *' }, run: (t) => t.prizeClaimReminders() },
];

const QUEUE = 'eduquest-scheduled';
const TICK_MS = 60_000;
const KEEP_RUNS_MS = 7 * 24 * 3_600_000;

/** BullMQ makes its own connections from options (it needs maxRetriesPerRequest: null). */
export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/**
 * Runs [TASKS] on a schedule. With REDIS_URL it uses BullMQ; without it, an
 * in-process timer does the job, so a single-server deployment needs nothing
 * extra. Set DISABLE_SCHEDULER=true to turn both off (e.g. a worker-only
 * deployment, or tests); jobs can always be run by hand with [runNow].
 *
 * In-process, every instance computes the same slot for a task and tries to
 * insert a (task, slot) row; the unique index lets exactly one win, so a slot
 * runs once however many instances or restarts there are. A failed run
 * releases its slot so the next tick retries it. Every task is also
 * idempotent, so an extra run is harmless.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private tasks: ScheduledTasksService,
    private prisma: PrismaService,
  ) {}

  get enabled(): boolean {
    return this.worker !== null || this.timer !== null;
  }

  private get mode(): 'bullmq' | 'in-process' | 'off' {
    if (this.worker) return 'bullmq';
    return this.timer ? 'in-process' : 'off';
  }

  async onModuleInit() {
    if (process.env.DISABLE_SCHEDULER === 'true') {
      this.log.warn('DISABLE_SCHEDULER=true: scheduled jobs are off (use POST /admin/jobs/:name/run).');
      return;
    }
    const url = process.env.REDIS_URL;
    if (!url) {
      this.startInProcess();
      return;
    }
    try {
      const connection = redisConnection(url);
      this.queue = new Queue(QUEUE, { connection });
      this.worker = new Worker(
        QUEUE,
        async (job) => {
          const task = TASKS.find((t) => t.name === job.name);
          if (!task) return { skipped: `unknown task ${job.name}` };
          return task.run(this.tasks);
        },
        { connection, concurrency: 1 },
      );
      this.worker.on('failed', (job, err) => this.log.error(`Job ${job?.name} failed: ${err.message}`));
      for (const t of TASKS) {
        // upsert: restarting (or running several instances) never duplicates a schedule.
        await this.queue.upsertJobScheduler(t.name, 'everyMs' in t.schedule ? { every: t.schedule.everyMs } : { pattern: t.schedule.pattern, tz: 'Africa/Lagos' }, { name: t.name });
      }
      this.log.log(`Scheduled ${TASKS.length} jobs (BullMQ).`);
    } catch (e) {
      this.log.error(`Could not start scheduled jobs on Redis: ${(e as Error).message}`);
      await this.onModuleDestroy();
      this.startInProcess();
    }
  }

  private startInProcess() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.log.log(`Scheduled ${TASKS.length} jobs (in-process; set REDIS_URL to use BullMQ).`);
    void this.tick(); // catch up straight away after a start or restart
  }

  /**
   * One pass: for each task, claim its latest slot and run it if this
   * instance won the claim. Public so tests (and a manual poke) can drive it.
   */
  async tick(now = new Date()): Promise<{ ran: string[] }> {
    const ran: string[] = [];
    if (this.ticking) return { ran };
    this.ticking = true;
    try {
      for (const t of TASKS) {
        const slot = latestSlot(t.schedule, now);
        if (!slot) continue;
        try {
          const claimed = await this.prisma.scheduledRun.createMany({ data: [{ task: t.name, slot: slot.key }], skipDuplicates: true });
          if (claimed.count === 0) continue; // already run (or running) elsewhere
          try {
            await t.run(this.tasks);
            await this.prisma.scheduledRun.updateMany({ where: { task: t.name, slot: slot.key }, data: { finishedAt: new Date() } });
            ran.push(t.name);
          } catch (e) {
            this.log.error(`Task ${t.name} failed, will retry: ${(e as Error).message}`);
            await this.prisma.scheduledRun.deleteMany({ where: { task: t.name, slot: slot.key } });
          }
        } catch (e) {
          this.log.error(`Scheduler could not reach the database for ${t.name}: ${(e as Error).message}`);
        }
      }
      await this.prisma.scheduledRun.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - KEEP_RUNS_MS) } } }).catch(() => undefined);
    } finally {
      this.ticking = false;
    }
    return { ran };
  }

  /** What exists and whether the scheduler is running. */
  describe() {
    return {
      scheduler: { bullmq: 'running (BullMQ)', 'in-process': 'running (in-process)', off: 'off (DISABLE_SCHEDULER=true)' }[this.mode],
      timezone: 'Africa/Lagos',
      tasks: TASKS.map((t) => ({ name: t.name, description: t.description, schedule: 'everyMs' in t.schedule ? `every ${t.schedule.everyMs / 60_000} minutes` : `cron ${t.schedule.pattern}` })),
    };
  }

  /** Queues one task to run on the worker (any instance), without waiting. Null when the scheduler is off. */
  async enqueue(name: string) {
    if (!this.queue || !TASKS.some((t) => t.name === name)) return null;
    const job = await this.queue.add(name, {}, { removeOnComplete: 100, removeOnFail: 100 });
    return { jobId: job.id };
  }

  /** Runs one task now, in this process. */
  async runNow(name: string) {
    const task = TASKS.find((t) => t.name === name);
    if (!task) return null;
    return { task: name, result: await task.run(this.tasks) };
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.worker = this.queue = null;
  }
}
