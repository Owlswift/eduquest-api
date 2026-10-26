import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
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
  { name: 'prize-claim-reminders', description: 'Remind winners to claim before the deadline', schedule: { pattern: '0 9 * * *' }, run: (t) => t.prizeClaimReminders() },
];

const QUEUE = 'eduquest-scheduled';

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
 * Runs [TASKS] on a schedule with BullMQ when REDIS_URL is set. Without
 * Redis it stays off (and says so): everything it would do is also done
 * lazily when data is read, or can be run by hand with [runNow], so the app
 * works either way. Because every task is idempotent, an extra or retried run
 * is harmless.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(private tasks: ScheduledTasksService) {}

  get enabled(): boolean {
    return this.worker !== null;
  }

  async onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.log.warn('REDIS_URL not set: scheduled jobs are off (use POST /admin/jobs/:name/run, or set REDIS_URL).');
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
      this.log.log(`Scheduled ${TASKS.length} jobs.`);
    } catch (e) {
      this.log.error(`Could not start scheduled jobs: ${(e as Error).message}`);
      await this.onModuleDestroy();
    }
  }

  /** What exists and whether the scheduler is running. */
  describe() {
    return {
      scheduler: this.enabled ? 'running' : 'off (no REDIS_URL)',
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
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.worker = this.queue = null;
  }
}
