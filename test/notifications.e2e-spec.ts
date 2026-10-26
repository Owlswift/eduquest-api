/**
 * Scheduled notifications and preferences against a REAL Postgres: that each
 * message goes out once however often the job runs, reaches only the right
 * students, and respects their settings. Skipped unless TEST_DATABASE_URL
 * points at a migrated, DISPOSABLE database (it clears daily activity and
 * competitions first).
 */
import { PrismaService } from '../src/database/prisma.service';
import { JobsService, TASKS } from '../src/modules/jobs/jobs.service';
import { ScheduledTasksService } from '../src/modules/jobs/scheduled-tasks.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('scheduled notifications (real database)', () => {
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let tasks: ScheduledTasksService;
  const push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
  const tag = `nt${Date.now()}`;
  const userIds: string[] = [];
  let n = 0;
  const day = 86_400_000;
  const today = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const lagosToday = () => {
    const l = new Date(Date.now() + 3_600_000);
    return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
  };
  const ago = (days: number) => new Date(lagosToday().getTime() - days * day);

  const make = async (over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `Stu Dent${n}`, username: id, email: `${id}@t.test`, classLevel: 'SS2', state: 'Lagos', ...over } });
    userIds.push(id);
    return id;
  };
  const activity = (userId: string, date: Date, questions = 5) => prisma.dailyActivity.create({ data: { userId, date, questionsAnswered: questions } });
  const got = (userId: string, type: string) => prisma.notification.findMany({ where: { userId, type } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    notifications = new NotificationsService(prisma, push as any);
    tasks = new ScheduledTasksService(prisma, notifications);
    await prisma.dailyActivity.deleteMany({});
    await prisma.competition.deleteMany({});
  });

  afterAll(async () => {
    await prisma.competition.deleteMany({ where: { title: { startsWith: tag } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  beforeEach(() => push.sendToUser.mockClear());

  describe('streak reminders', () => {
    it('reach students who studied yesterday but not today, once a day', async () => {
      const atRisk = await make({ streak: 3 });
      const done = await make({ streak: 3 });
      const stale = await make({ streak: 5 }); // streak counter is old: last study was 3 days ago
      const optedOut = await make({ streak: 2 });
      const noStreak = await make({ streak: 0 });
      await activity(atRisk, ago(1));
      await activity(done, ago(1)); await activity(done, ago(0));
      await activity(stale, ago(3));
      await activity(optedOut, ago(1));
      await activity(noStreak, ago(1));
      await prisma.notificationPreference.create({ data: { userId: optedOut, studyReminders: false } });

      const first = await tasks.streakReminders();
      expect(await got(atRisk, 'streak_reminder')).toHaveLength(1);
      expect((await got(atRisk, 'streak_reminder'))[0]).toMatchObject({ title: 'Keep your 3 day streak' });
      for (const u of [done, stale, optedOut, noStreak]) expect(await got(u, 'streak_reminder')).toHaveLength(0);
      expect(first.sent).toBeGreaterThanOrEqual(1);

      const pushed = push.sendToUser.mock.calls.length;
      const again = await tasks.streakReminders(); // retried or run twice
      expect(again.sent).toBe(0);
      expect(await got(atRisk, 'streak_reminder')).toHaveLength(1);
      expect(push.sendToUser.mock.calls.length).toBe(pushed); // no second push either
    });

    it('does not push to someone who turned push off, but still fills their in-app feed', async () => {
      const u = await make({ streak: 4 });
      await activity(u, ago(1));
      await prisma.notificationPreference.create({ data: { userId: u, push: false } });
      await tasks.streakReminders();
      expect(await got(u, 'streak_reminder')).toHaveLength(1);
      expect(push.sendToUser.mock.calls.some((c) => c[0] === u)).toBe(false);
    });
  });

  describe('daily challenge prompt', () => {
    it('goes to recently active students once per day', async () => {
      const recent = await make();
      const lapsed = await make();
      await activity(recent, ago(5));
      await activity(lapsed, ago(20));
      await tasks.dailyChallengeReady();
      await tasks.dailyChallengeReady();
      expect(await got(recent, 'daily_challenge_ready')).toHaveLength(1);
      expect(await got(lapsed, 'daily_challenge_ready')).toHaveLength(0);
    });
  });

  describe('competitions', () => {
    const create = (over: Record<string, unknown> = {}) =>
      prisma.competition.create({
        data: {
          title: `${tag} ${++n}`, subtitle: 's', prizes: [], format: 'FIXED_SET', type: 'STATE', state: 'Lagos', classLevels: ['SS2'],
          status: 'PUBLISHED', questionCount: 10, timeLimitSec: 1800, startsAt: new Date(Date.now() - 2 * 3_600_000), endsAt: new Date(Date.now() + 3 * day), ...over,
        } as any,
      });

    it('opens on time, tells only the students who can enter and have been active, and never twice', async () => {
      const eligible = await make({ state: 'Lagos', classLevel: 'SS2' });
      const wrongClass = await make({ state: 'Lagos', classLevel: 'SS1' });
      const wrongState = await make({ state: 'Kano', classLevel: 'SS2' });
      const dormant = await make({ state: 'Lagos', classLevel: 'SS2' });
      for (const u of [eligible, wrongClass, wrongState]) await activity(u, ago(2));
      await activity(dormant, ago(40));
      const c = await create();

      const run = await tasks.advanceCompetitions();
      expect(run.advanced).toBe(1);
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE'); // persisted
      const msgs = await got(eligible, 'competition_open');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toMatch(/10 questions, 30 minutes/);
      for (const u of [wrongClass, wrongState, dormant]) expect(await got(u, 'competition_open')).toHaveLength(0);

      expect((await tasks.advanceCompetitions()).opened).toBe(0);
      expect(await got(eligible, 'competition_open')).toHaveLength(1);
    });

    it('sends a closing-soon nudge only to entrants who have not finished', async () => {
      const waiting = await make();
      const inProgress = await make();
      const finished = await make();
      const c = await create({ startsAt: new Date(Date.now() - 2 * day), endsAt: new Date(Date.now() + 10 * 3_600_000), status: 'ACTIVE' });
      await prisma.competitionParticipant.createMany({
        data: [
          { competitionId: c.id, userId: waiting, status: 'ENTERED' },
          { competitionId: c.id, userId: inProgress, status: 'IN_PROGRESS' },
          { competitionId: c.id, userId: finished, status: 'COMPLETED' },
        ],
      });
      const r = await tasks.advanceCompetitions();
      expect(r.closingSoon).toBe(2);
      expect(await got(waiting, 'competition_closing')).toHaveLength(1);
      expect(await got(inProgress, 'competition_closing')).toHaveLength(1);
      expect(await got(finished, 'competition_closing')).toHaveLength(0);
      expect((await tasks.advanceCompetitions()).closingSoon).toBe(0);
    });

    it('closes a competition whose time is up, and respects the competitions switch', async () => {
      const u = await make();
      await prisma.notificationPreference.create({ data: { userId: u, competitions: false } });
      await activity(u, ago(1));
      const c = await create({ startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - 1000), status: 'ACTIVE' });
      const open = await create();
      await tasks.advanceCompetitions();
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CLOSED');
      expect(await got(u, 'competition_open')).toHaveLength(0); // switched off
      expect(open.id).toBeDefined();
    });
  });

  describe('prize claim reminders', () => {
    it('remind winners a few days before the deadline, even with every switch off, once', async () => {
      const winner = await make();
      const early = await make();
      const c = await prisma.competition.create({ data: { title: `${tag} prizes`, subtitle: 's', prizes: [], format: 'FIXED_SET', status: 'FINALISED', startsAt: new Date(Date.now() - 9 * day), endsAt: new Date(Date.now() - 2 * day) } });
      const prize = await prisma.competitionPrize.create({ data: { competitionId: c.id, positionFrom: 1, positionTo: 2, title: 'Tablet', kind: 'DEVICE' } });
      await prisma.notificationPreference.create({ data: { userId: winner, studyReminders: false, competitions: false, achievements: false, push: false } });
      await prisma.prizeAward.create({ data: { competitionId: c.id, prizeId: prize.id, userId: winner, rank: 1, claimDeadline: new Date(Date.now() + 2 * day) } });
      await prisma.prizeAward.create({ data: { competitionId: c.id, prizeId: prize.id, userId: early, rank: 2, claimDeadline: new Date(Date.now() + 10 * day) } });

      expect((await tasks.prizeClaimReminders()).sent).toBe(1);
      expect((await tasks.prizeClaimReminders()).sent).toBe(0);
      const msgs = await got(winner, 'prize_claim_reminder');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].title).toContain('Tablet');
      expect(await got(early, 'prize_claim_reminder')).toHaveLength(0);
    });
  });

  describe('preferences', () => {
    it('are respected by direct notifications, except for money and prizes', async () => {
      const u = await make();
      await notifications.updatePreferences(u, { achievements: false, competitions: false });
      expect(await notifications.notify(u, 'level_up', 'T', 'B')).toBeNull();
      expect(await notifications.notify(u, 'competition_results', 'T', 'B')).toBeNull();
      expect(await notifications.notify(u, 'prize_won', 'T', 'B')).not.toBeNull();
      expect(await notifications.notify(u, 'reward_fulfilled', 'T', 'B')).not.toBeNull();
      expect(await notifications.notify(u, 'streak_reminder', 'T', 'B')).not.toBeNull(); // study is still on
      expect(await notifications.preferencesFor(u)).toEqual({ studyReminders: true, competitions: false, achievements: false, push: true });
    });
  });

  describe('scheduler', () => {
    it('describes its tasks and stays off when disabled, while tasks still run by hand', async () => {
      delete process.env.REDIS_URL;
      process.env.DISABLE_SCHEDULER = 'true';
      const jobs = new JobsService(tasks, prisma);
      await jobs.onModuleInit();
      delete process.env.DISABLE_SCHEDULER;
      expect(jobs.enabled).toBe(false);
      const d = jobs.describe();
      expect(d.scheduler).toMatch(/off/);
      expect(d.tasks.map((t) => t.name)).toEqual(TASKS.map((t) => t.name));
      expect(d.tasks.find((t) => t.name === 'streak-reminder')!.schedule).toBe('cron 0 18 * * *');
      expect(await jobs.enqueue('streak-reminder')).toBeNull();
      expect(await jobs.runNow('nope')).toBeNull();
      expect(await jobs.runNow('prize-claim-reminders')).toMatchObject({ task: 'prize-claim-reminders' });
    });
  });
});
