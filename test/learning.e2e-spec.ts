/**
 * Daily challenges and exam simulation against a REAL Postgres: the clock,
 * the one-attempt rules and the one-time payouts can't be proven with mocks.
 * Skipped unless TEST_DATABASE_URL points at a migrated, DISPOSABLE database: it deletes all
 * SS3 questions and all daily challenges first.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { ActivityService } from '../src/modules/activity/activity.service';
import { DailyChallengesService, DAILY_REWARDS } from '../src/modules/daily-challenges/daily-challenges.service';
import { ExamsService } from '../src/modules/exams/exams.service';
import { AchievementsService } from '../src/modules/gamification/achievements.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { AttemptsService } from '../src/modules/progress/attempts.service';
import { QuizService } from '../src/modules/quiz/quiz.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('daily challenges and exams (real database)', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let quiz: QuizService;
  let daily: DailyChallengesService;
  let exams: ExamsService;
  let achievements: AchievementsService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `ln${Date.now()}`;
  const subjectA = `${tag}-a`;
  const subjectB = `${tag}-b`;
  const userIds: string[] = [];
  let n = 0;

  const makeUser = async (over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `U ${n}`, username: id, email: `${id}@t.test`, ...over } });
    userIds.push(id);
    return id;
  };
  const makeQuestions = async (subjectId: string, count: number, prefix: string, extra: Record<string, unknown> = {}) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${tag}-${prefix}${i}`;
      await prisma.question.create({
        data: {
          id, subjectId, classLevel: 'SS3', questionText: `Q ${id}`, correctAnswerId: `${id}_a`,
          options: { create: [{ id: `${id}_a`, text: 'A' }, { id: `${id}_b`, text: 'B' }] }, ...extra,
        },
      });
      ids.push(id);
    }
    return ids;
  };
  const balances = async (id: string) => {
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
    const activity = new ActivityService(prisma);
    const attempts = new AttemptsService(prisma);
    achievements = new AchievementsService(prisma, ledger, { notify } as any);
    quiz = new QuizService(prisma, activity, ledger, attempts, achievements);
    daily = new DailyChallengesService(prisma);
    exams = new ExamsService(prisma, activity, attempts, achievements);
    // Class level SS3 is used by every test question; clear any other SS3 data from earlier runs.
    await prisma.dailyChallenge.deleteMany({});
    await prisma.subject.createMany({
      data: [
        { id: subjectA, name: `${tag}A`, icon: 'i', color: '#000' },
        { id: subjectB, name: `${tag}B`, icon: 'i', color: '#000' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.dailyChallenge.deleteMany({});
    await prisma.subject.deleteMany({ where: { id: { in: [subjectA, subjectB] } } });
    await prisma.$disconnect();
  });

  describe('daily challenge', () => {
    beforeAll(async () => {
      await prisma.question.deleteMany({ where: { classLevel: 'SS3', subjectId: { notIn: [subjectA, subjectB] } } });
      await makeQuestions(subjectA, 4, 'da');
      await makeQuestions(subjectB, 4, 'db');
    });

    it('gives every student of a class the same questions, even when asked simultaneously', async () => {
      const users = await Promise.all([1, 2, 3, 4].map(() => makeUser({ classLevel: 'SS3' })));
      const sets = await Promise.all(users.map((u) => daily.start(u)));
      const first = sets[0].map((q) => q.id).join(',');
      expect(sets.every((s) => s.map((q) => q.id).join(',') === first)).toBe(true);
      expect(sets[0]).toHaveLength(5);
      expect(sets[0][0]).not.toHaveProperty('correctAnswerId');
      expect(await prisma.dailyChallenge.count({ where: { classLevel: 'SS3' } })).toBe(1);
    });

    it('reports state: available, in progress, completed', async () => {
      const u = await makeUser({ classLevel: 'SS3' });
      expect((await daily.status(u)).state).toBe('AVAILABLE');
      const qs = await daily.start(u);
      const mid = await daily.status(u);
      expect(mid).toMatchObject({ state: 'IN_PROGRESS', sessionId: qs[0].sessionId, questionCount: 5 });

      const resumed = await daily.start(u); // resume gives the same session
      expect(resumed[0].sessionId).toBe(qs[0].sessionId);

      await quiz.submitQuizResults(u, {
        sessionId: qs[0].sessionId,
        answers: qs.map((q) => ({ questionId: q.id, selectedOptionId: `${q.id}_a` })),
        timeTaken: 20,
      });
      expect(await daily.status(u)).toMatchObject({ state: 'COMPLETED', result: { correct: 5, total: 5 } });
      await expect(daily.start(u)).rejects.toBeInstanceOf(ConflictException);
    });

    it('pays the completion and perfect bonuses once, under concurrent submits', async () => {
      const u = await makeUser({ classLevel: 'SS3' });
      const qs = await daily.start(u);
      const body = { sessionId: qs[0].sessionId, answers: qs.map((q) => ({ questionId: q.id, selectedOptionId: `${q.id}_a` })), timeTaken: 9 };

      const attempts = await Promise.allSettled([1, 2, 3].map(() => quiz.submitQuizResults(u, body)).map((p) => p));
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

      const b = await balances(u);
      const bonusXp = DAILY_REWARDS.completionXp + DAILY_REWARDS.perfectXp;
      const bonusCoins = DAILY_REWARDS.completionCoins + DAILY_REWARDS.perfectCoins;
      // Achievements add their own rewards (Daily Challenger, First Steps, Sharpshooter), so
      // check the daily rows themselves.
      const dailyRows = await prisma.ledgerEntry.findMany({ where: { userId: u, reason: 'daily_challenge' } });
      expect(dailyRows.filter((r) => r.currency === 'XP').reduce((n, r) => n + r.amount, 0)).toBe(bonusXp);
      expect(dailyRows.filter((r) => r.currency === 'COIN').reduce((n, r) => n + r.amount, 0)).toBe(bonusCoins);
      expect(b.xp).toBe(b.ledgerXp);
      expect(b.coins).toBe(b.ledgerCoins);
    });

    it('pays only the completion bonus for an imperfect run, and tracks accuracy per subject', async () => {
      const u = await makeUser({ classLevel: 'SS3' });
      const qs = await daily.start(u);
      const res = await quiz.submitQuizResults(u, {
        sessionId: qs[0].sessionId,
        answers: qs.map((q, i) => ({ questionId: q.id, selectedOptionId: `${q.id}_${i === 0 ? 'b' : 'a'}` })),
        timeTaken: 9,
      });
      expect(res.daily).toEqual({ completed: true, perfect: false });
      expect(res.earnedXp).toBe(DAILY_REWARDS.completionXp);

      const stats = await prisma.subjectStat.findMany({ where: { userId: u } });
      expect(stats.reduce((n, s) => n + s.questionsAnswered, 0)).toBe(5);
      expect(stats.every((s) => [subjectA, subjectB].includes(s.subjectId))).toBe(true);
      expect(await prisma.questionAttempt.count({ where: { userId: u, source: 'DAILY' } })).toBe(5);
      const keys = (await prisma.userAchievement.findMany({ where: { userId: u } })).map((a) => a.key);
      expect(keys).toContain('daily_first');
    });

    it('is unavailable for a class with too few questions', async () => {
      const u = await makeUser({ classLevel: 'JSS1' });
      expect((await daily.status(u)).state).toBe('UNAVAILABLE');
      await expect(daily.start(u)).rejects.toThrow();
    });
  });

  describe('exam simulation', () => {
    let waec: string[];
    let general: string[];
    beforeAll(async () => {
      waec = await makeQuestions(subjectA, 12, 'xw', { examType: 'WAEC', examYear: 2019, topic: 'Algebra' });
      general = await makeQuestions(subjectA, 6, 'xg', { topic: 'Geometry' });
    });

    const start = (u: string, over: Record<string, unknown> = {}) =>
      exams.start(u, { subjectId: subjectA, examType: 'WAEC', count: 10, ...over } as any);
    const answers = (qs: { id: string }[], pick: (i: number) => 'a' | 'b') =>
      qs.map((q, i) => ({ questionId: q.id, selectedOptionId: `${q.id}_${pick(i)}` }));

    it('uses past questions of the chosen exam first and hides the answers while running', async () => {
      const u = await makeUser();
      const e = await start(u);
      expect(e.questions).toHaveLength(10);
      expect(e.pastQuestionsOnly).toBe(true);
      expect(e.questions.every((q) => waec.includes(q.id))).toBe(true);
      expect(e.questions[0]).not.toHaveProperty('correctAnswerId');
      expect(e.durationSec).toBe(600);
      expect(e.remainingSec).toBeGreaterThan(590);
      await exams.submit(u, e.examId);
    });

    it('tops up from the general bank, and says so, when past questions run short', async () => {
      const u = await makeUser();
      const e = await start(u, { count: 16 });
      expect(e.pastQuestionsOnly).toBe(false);
      expect(e.questions).toHaveLength(16);
      expect(e.questions.filter((q) => waec.includes(q.id))).toHaveLength(12);
      await exams.submit(u, e.examId);
    });

    it('allows one exam at a time', async () => {
      const u = await makeUser();
      const e = await start(u);
      await expect(start(u)).rejects.toBeInstanceOf(ConflictException);
      await exams.submit(u, e.examId);
      await expect(start(u)).resolves.toBeDefined();
    });

    it('autosaves, then grades once with no XP or coins, counting toward the streak', async () => {
      const u = await makeUser();
      const e = await start(u);
      await exams.saveAnswers(u, e.examId, answers(e.questions.slice(0, 6), () => 'a'));
      const resumed = await exams.get(u, e.examId);
      expect(resumed.status).toBe('IN_PROGRESS');
      expect(Object.keys((resumed as any).savedAnswers)).toHaveLength(6);

      const results = await Promise.all(
        [1, 2, 3, 4].map(() => exams.submit(u, e.examId, answers(e.questions.slice(6, 8), () => 'b'))),
      );
      expect(new Set(results.map((r) => r.score)).size).toBe(1);
      expect(results[0]).toMatchObject({ status: 'SUBMITTED', score: 6, total: 10, percentage: 60, answered: 8 });

      expect(await prisma.questionAttempt.count({ where: { userId: u, source: 'EXAM' } })).toBe(10); // once, not 4x
      const user = await prisma.user.findUniqueOrThrow({ where: { id: u } });
      expect(user.questionsAnswered).toBe(10);
      expect(await prisma.ledgerEntry.count({ where: { userId: u, reason: { in: ['quiz', 'exam'] } } })).toBe(0);
      expect(await prisma.dailyActivity.count({ where: { userId: u, questionsAnswered: 10 } })).toBe(1);
      // First Steps and Exam Ready come from the achievements engine, not the exam.
      const keys = (await prisma.userAchievement.findMany({ where: { userId: u } })).map((a) => a.key);
      expect(keys).toContain('exam_ready');
    });

    it('ignores answers saved or submitted after the deadline', async () => {
      const u = await makeUser();
      const e = await start(u);
      await exams.saveAnswers(u, e.examId, answers(e.questions.slice(0, 3), () => 'a')); // in time
      // Time runs out 5 minutes ago (beyond the grace period).
      await prisma.examSession.update({ where: { id: e.examId }, data: { endsAt: new Date(Date.now() - 5 * 60_000) } });

      await expect(exams.saveAnswers(u, e.examId, answers(e.questions.slice(3, 9), () => 'a'))).rejects.toBeInstanceOf(
        BadRequestException,
      ); // closes the exam instead
      const result = await exams.submit(u, e.examId, answers(e.questions.slice(3, 9), () => 'a'));
      expect(result).toMatchObject({ score: 3, answered: 3 }); // only the in-time answers count
    });

    it('settles an overdue exam when the student returns, and when they start a new one', async () => {
      const u = await makeUser();
      const e = await start(u);
      await exams.saveAnswers(u, e.examId, answers(e.questions.slice(0, 4), () => 'a'));
      await prisma.examSession.update({ where: { id: e.examId }, data: { endsAt: new Date(Date.now() - 60_000) } });

      const back = await exams.get(u, e.examId);
      expect(back).toMatchObject({ status: 'SUBMITTED', score: 4 });

      const u2 = await makeUser();
      const e2 = await start(u2);
      await exams.saveAnswers(u2, e2.examId, answers(e2.questions.slice(0, 2), () => 'a'));
      await prisma.examSession.update({ where: { id: e2.examId }, data: { endsAt: new Date(Date.now() - 60_000) } });
      await start(u2); // does not 409: the old one is finalised
      expect((await prisma.examSession.findUniqueOrThrow({ where: { id: e2.examId } })).status).toBe('SUBMITTED');
      expect((await exams.history(u2)).find((h) => h.examId === e2.examId)).toMatchObject({ score: 2, total: 10 });
    });

    it('shows the review only after the exam ends, with the right answers and topic breakdown', async () => {
      const u = await makeUser();
      const e = await start(u);
      await expect(exams.review(u, e.examId)).rejects.toBeInstanceOf(BadRequestException);

      await exams.submit(u, e.examId, answers(e.questions, (i) => (i < 7 ? 'a' : 'b')));
      const r = await exams.review(u, e.examId);
      expect(r.score).toBe(7);
      expect(r.items).toHaveLength(10);
      expect(r.items.filter((i) => i.correct)).toHaveLength(7);
      expect(r.items[0].correctOptionId).toBe(`${r.items[0].questionId}_a`);
      expect(r.byTopic).toEqual([{ topic: 'Algebra', total: 10, correct: 7 }]);
    });

    it('is private to its owner', async () => {
      const owner = await makeUser();
      const other = await makeUser();
      const e = await start(owner);
      await expect(exams.get(other, e.examId)).rejects.toThrow();
      await expect(exams.submit(other, e.examId)).rejects.toThrow();
      await exams.submit(owner, e.examId);
    });
  });
});
