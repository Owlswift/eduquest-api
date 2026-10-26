/**
 * Progression against a REAL Postgres: levels, achievements, attempt history
 * and the longest-streak record. Skipped unless TEST_DATABASE_URL points at a
 * migrated, disposable database.
 */
import { PrismaService } from '../src/database/prisma.service';
import { ActivityService } from '../src/modules/activity/activity.service';
import { AchievementsService } from '../src/modules/gamification/achievements.service';
import { GamificationService } from '../src/modules/gamification/gamification.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { AttemptsService } from '../src/modules/progress/attempts.service';
import { QuizService } from '../src/modules/quiz/quiz.service';
import { UsersService } from '../src/modules/users/users.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('progression (real database)', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let quiz: QuizService;
  let achievements: AchievementsService;
  let attempts: AttemptsService;
  let activity: ActivityService;
  let users: UsersService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `pg${Date.now()}`;
  const subjectId = `${tag}-subj`;
  const userIds: string[] = [];
  let n = 0;

  const makeUser = async (over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `U ${n}`, username: id, email: `${id}@t.test`, ...over } });
    userIds.push(id);
    return id;
  };
  const makeQuestions = async (count: number, prefix: string, topic: string | null = null) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${tag}-${prefix}${i}`;
      await prisma.question.create({
        data: {
          id, subjectId, classLevel: 'SS1', topic, questionText: `Q ${id}`, correctAnswerId: `${id}_a`,
          options: { create: [{ id: `${id}_a`, text: 'A' }, { id: `${id}_b`, text: 'B' }] },
        },
      });
      ids.push(id);
    }
    return ids;
  };
  const take = async (userId: string, count: number, pick: (q: string) => 'a' | 'b') => {
    const qs = await quiz.getRandomQuestions(userId, subjectId, count, 'SS1' as any);
    return {
      sessionId: qs[0].sessionId,
      ids: qs.map((q) => q.id),
      answers: qs.map((q) => ({ questionId: q.id, selectedOptionId: `${q.id}_${pick(q.id)}` })),
    };
  };
  const reconciles = async (id: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    const sum = async (c: 'XP' | 'COIN') =>
      (await prisma.ledgerEntry.aggregate({ where: { userId: id, currency: c }, _sum: { amount: true } }))._sum.amount ?? 0;
    return { xp: u.xp, ledgerXp: await sum('XP'), coins: u.coins, ledgerCoins: await sum('COIN') };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    ledger = new LedgerService(prisma);
    activity = new ActivityService(prisma);
    attempts = new AttemptsService(prisma);
    achievements = new AchievementsService(prisma, ledger, { notify } as any);
    new GamificationService(ledger, { notify } as any, achievements).onModuleInit();
    quiz = new QuizService(prisma, activity, ledger, attempts, achievements);
    users = new UsersService(prisma, activity, { notify } as any, ledger, quiz, achievements);
    await prisma.subject.create({ data: { id: subjectId, name: tag, icon: 'i', color: '#000' } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.subject.delete({ where: { id: subjectId } });
    await prisma.$disconnect();
  });

  describe('levels', () => {
    it('raises the level in the same transaction as the XP and announces it once', async () => {
      const u = await makeUser();
      notify.mockClear();

      const res = await ledger.grant({ userId: u, xp: 600, reason: 't', key: `lv:${u}` });

      expect(res.levelUp).toEqual({ from: 1, to: 2 });
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u } });
      expect(row).toMatchObject({ xp: 600, level: 2, maxXp: 1100 });
      await new Promise((r) => setTimeout(r, 100)); // listener runs after the grant
      expect(notify.mock.calls.filter((c) => c[1] === 'level_up')).toHaveLength(1);
    });

    it('jumps several levels at once and replays pay nothing', async () => {
      const u = await makeUser();
      const grant = () => ledger.grant({ userId: u, xp: 2600, reason: 't', key: `big:${u}` });
      const [a, b] = await Promise.all([grant(), grant()]);
      expect([a, b].filter((r) => r.applied)).toHaveLength(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u } })).level).toBe(5);
    });

    it('does not announce when the grant carries no level change', async () => {
      const u = await makeUser();
      const res = await ledger.grant({ userId: u, xp: 10, reason: 't', key: `small:${u}` });
      expect(res.levelUp).toBeUndefined();
    });
  });

  describe('attempt history', () => {
    beforeAll(async () => {
      await makeQuestions(12, 'alg', 'Algebra');
    });

    it('stores one attempt per issued question, with the topic', async () => {
      const u = await makeUser();
      const s = await take(u, 12, (q) => (Number(q.slice(-2).replace(/\D/g, '')) % 2 === 0 ? 'a' : 'b'));
      await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers: s.answers, timeTaken: 5 });

      const rows = await prisma.questionAttempt.findMany({ where: { userId: u } });
      expect(rows).toHaveLength(12);
      expect(rows.every((r) => r.topic === 'Algebra' && r.source === 'QUIZ' && r.sourceRefId === s.sessionId)).toBe(true);
      const stats = await attempts.topicStats(u, { subjectId });
      expect(stats).toHaveLength(1);
      expect(stats[0]).toMatchObject({ topic: 'Algebra', attempts: 12, evidence: 'solid' });
      expect(stats[0].correct).toBe(rows.filter((r) => r.correct).length);
    });

    it('lists a topic as weak only with enough evidence and low accuracy', async () => {
      const u = await makeUser();
      const s = await take(u, 12, () => 'b'); // all wrong
      await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers: s.answers, timeTaken: 5 });
      const weak = await attempts.weakTopics(u, { subjectId });
      expect(weak.map((w) => w.topic)).toEqual(['Algebra']);

      const few = await makeUser();
      const t = await take(few, 5, () => 'b'); // only 5 answers: too little evidence
      await quiz.submitQuizResults(few, { sessionId: t.sessionId, answers: t.answers, timeTaken: 5 });
      expect(await attempts.weakTopics(few, { subjectId })).toEqual([]);
    });
  });

  describe('achievements', () => {
    it('unlocks First Steps and Sharpshooter after a perfect quiz, once, and pays the reward once', async () => {
      const u = await makeUser();
      const s = await take(u, 5, () => 'a');
      const res = await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers: s.answers, timeTaken: 5 });

      expect(res.newAchievements.map((a) => a.key).sort()).toEqual(['first_steps', 'sharpshooter']);
      const owned = await prisma.userAchievement.findMany({ where: { userId: u } });
      expect(owned).toHaveLength(2);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: u } });
      expect(user.badges).toBe(2);
      // 5 correct x 10 XP, plus 20 (First Steps) and 40 (Sharpshooter).
      expect(user.xp).toBe(50 + 20 + 40);
      const r = await reconciles(u);
      expect(r.xp).toBe(r.ledgerXp);
      expect(r.coins).toBe(r.ledgerCoins);
    });

    it('never double-unlocks or double-pays under concurrent evaluation', async () => {
      const u = await makeUser();
      const s = await take(u, 5, () => 'a');
      await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers: s.answers, timeTaken: 5 });
      const before = await reconciles(u);

      const results = await Promise.all(Array.from({ length: 6 }, () => achievements.evaluate(u)));

      expect(results.flat()).toHaveLength(0); // everything already unlocked
      expect(await prisma.userAchievement.count({ where: { userId: u } })).toBe(2);
      expect(await reconciles(u)).toEqual(before);
    });

    it('unlocks a level achievement when XP crosses the threshold', async () => {
      const u = await makeUser();
      await ledger.grant({ userId: u, xp: 1100, reason: 't', key: `l3:${u}` });
      await new Promise((r) => setTimeout(r, 300)); // level-up listener evaluates
      const keys = (await prisma.userAchievement.findMany({ where: { userId: u } })).map((a) => a.key);
      expect(keys).toContain('level_3');
      const r = await reconciles(u);
      expect(r.coins).toBe(r.ledgerCoins);
    });

    it('awards First Steps from the starter challenge and recounts the badge total', async () => {
      const u = await makeUser();
      const s = await take(u, 3, () => 'a');
      const res = await users.completeStarterChallenge(u, s.sessionId, s.answers);

      expect(res.newAchievements.map((a) => a.key)).toContain('first_steps');
      expect(res.badges).toBe(res.newAchievements.length);
      const r = await reconciles(u);
      expect(r.xp).toBe(r.ledgerXp);
    });

    it('reports progress toward locked achievements', async () => {
      const u = await makeUser({ questionsAnswered: 40 });
      const list = await achievements.list(u);
      const century = list.find((a) => a.key === 'century')!;
      expect(century).toMatchObject({ unlocked: false, current: 40, target: 100 });
    });
  });

  describe('longest streak', () => {
    it('records a new best and never lowers it', async () => {
      const u = await makeUser();
      const today = activity['lagosDate']();
      const day = (offset: number) => new Date(today.getTime() - offset * 86400000);
      for (const off of [0, 1, 2, 3]) {
        await prisma.dailyActivity.create({ data: { userId: u, date: day(off), questionsAnswered: 3 } });
      }
      expect(await activity.recomputeStreak(u)).toBe(4);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u } })).longestStreak).toBe(4);

      await prisma.dailyActivity.deleteMany({ where: { userId: u, date: { in: [day(1), day(2), day(3)] } } });
      expect(await activity.recomputeStreak(u)).toBe(1);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u } });
      expect(row.streak).toBe(1);
      expect(row.longestStreak).toBe(4);
    });
  });
});
