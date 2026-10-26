/**
 * Integrity tests against a REAL Postgres - the guarantees here (conditional
 * UPDATEs, ON CONFLICT DO NOTHING, atomic session close) can't be proven with
 * mocks. Skipped unless TEST_DATABASE_URL points at a database that has had
 * all migrations applied. It creates and deletes its own rows.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5499/t pnpm test:e2e
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { LedgerCurrency } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { ActivityService } from '../src/modules/activity/activity.service';
import { ChallengesService } from '../src/modules/challenges/challenges.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { CompetitionSittingsService } from '../src/modules/competitions/competition-sittings.service';
import { QuizService, QUIZ_DAILY_REWARD_CAP } from '../src/modules/quiz/quiz.service';
import { AuditService } from '../src/modules/admin/audit.service';
import { RewardsService } from '../src/modules/rewards/rewards.service';
import { UsersService } from '../src/modules/users/users.service';
import { AchievementsService } from '../src/modules/gamification/achievements.service';
import { AttemptsService } from '../src/modules/progress/attempts.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('integrity (real database)', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let quiz: QuizService;
  let rewards: RewardsService;
  let users: UsersService;
  let challenges: ChallengesService;
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const tag = `it${Date.now()}`;
  const subjectId = `${tag}-subj`;
  const userIds: string[] = [];
  let n = 0;

  const makeUser = async (over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({
      data: { id, fullName: `User ${n}`, username: id, email: `${id}@t.test`, ...over },
    });
    userIds.push(id);
    return id;
  };

  /** Creates `count` questions whose correct option is `<id>_a`. */
  const makeQuestions = async (count: number, prefix: string) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${tag}-${prefix}${i}`;
      await prisma.question.create({
        data: {
          id,
          subjectId,
          classLevel: 'SS1',
          questionText: `Q ${id}`,
          correctAnswerId: `${id}_a`,
          options: { create: [{ id: `${id}_a`, text: 'A' }, { id: `${id}_b`, text: 'B' }] },
        },
      });
      ids.push(id);
    }
    return ids;
  };

  const balances = async (id: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { xp: true, coins: true } });
    const sum = async (currency: LedgerCurrency) =>
      (await prisma.ledgerEntry.aggregate({ where: { userId: id, currency }, _sum: { amount: true } }))
        ._sum.amount ?? 0;
    return { ...u, ledgerXp: await sum('XP'), ledgerCoins: await sum('COIN') };
  };

  /** Takes a session, answering every question with `pick(questionId)`. */
  const takeQuiz = async (userId: string, count: number, pick: (qid: string) => 'a' | 'b') => {
    const qs = await quiz.getRandomQuestions(userId, subjectId, count, 'SS1' as any);
    const answers = qs.map((q) => ({ questionId: q.id, selectedOptionId: `${q.id}_${pick(q.id)}` }));
    return { sessionId: qs[0].sessionId, answers, ids: qs.map((q) => q.id) };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    ledger = new LedgerService(prisma);
    const activity = new ActivityService(prisma);
    const attempts = new AttemptsService(prisma);
    // Achievement rewards add XP of their own; they are covered in progression.e2e-spec.ts.
    const achievements = { evaluate: async () => [] } as unknown as AchievementsService;
    quiz = new QuizService(prisma, activity, ledger, attempts, achievements, new CompetitionSittingsService(prisma, ledger));
    rewards = new RewardsService(prisma, notifications as any, ledger, new AuditService(prisma));
    users = new UsersService(prisma, activity, notifications as any, ledger, quiz, achievements);
    challenges = new ChallengesService(prisma, notifications as any, ledger, attempts, achievements);
    await prisma.subject.create({ data: { id: subjectId, name: tag, icon: 'i', color: '#000' } });
  });

  afterAll(async () => {
    await prisma.challenge.deleteMany({ where: { subjectId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // cascades ledger + sessions
    await prisma.subject.delete({ where: { id: subjectId } }); // cascades questions
    await prisma.$disconnect();
  });

  describe('ledger', () => {
    it('applies a grant once however often it is replayed', async () => {
      const u = await makeUser();
      const grant = () => ledger.grant({ userId: u, xp: 10, coins: 5, reason: 't', key: `k:${u}` });
      const results = await Promise.all([grant(), grant(), grant(), grant()]);

      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(await balances(u)).toEqual({ xp: 10, coins: 5, ledgerXp: 10, ledgerCoins: 5 });
    });

    it('never lets concurrent spends overdraw', async () => {
      const u = await makeUser({ coins: 100 });
      await prisma.ledgerEntry.create({
        data: { userId: u, currency: 'COIN', amount: 100, reason: 'seed', idempotencyKey: `seed:${u}` },
      });

      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          ledger.spendCoins({ userId: u, coins: 30, reason: 't', key: `spend:${u}:${i}` }),
        ),
      );

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(3);
      const b = await balances(u);
      expect(b.coins).toBe(10);
      expect(b.ledgerCoins).toBe(10);
    });
  });

  describe('rewards', () => {
    const cost = 500;
    const rewardId = 'airtime_500'; // seeded by the rewards migration

    it('pays for concurrent redemptions only as far as the balance reaches', async () => {
      const u = await makeUser({ coins: cost * 2 + 1 });
      await prisma.ledgerEntry.create({
        data: { userId: u, currency: 'COIN', amount: cost * 2 + 1, reason: 'seed', idempotencyKey: `seed:${u}` },
      });

      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () => rewards.redeem(u, rewardId)),
      );

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(2);
      expect(await prisma.rewardRedemption.count({ where: { userId: u } })).toBe(2);
      const b = await balances(u);
      expect(b.coins).toBe(1);
      expect(b.ledgerCoins).toBe(1);
    });

    it('refunds a rejected redemption exactly once', async () => {
      const u = await makeUser({ coins: cost });
      await prisma.ledgerEntry.create({
        data: { userId: u, currency: 'COIN', amount: cost, reason: 'seed', idempotencyKey: `seed:${u}` },
      });
      await rewards.redeem(u, rewardId);
      const red = await prisma.rewardRedemption.findFirstOrThrow({ where: { userId: u } });
      const adminUser = await makeUser({ role: 'ADMIN' });

      const attempts = await Promise.allSettled([
        rewards.adminReject(adminUser, red.id),
        rewards.adminReject(adminUser, red.id),
        rewards.adminFulfill(adminUser, red.id),
      ]);

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      const b = await balances(u);
      expect(b.coins === cost || b.coins === 0).toBe(true); // refunded once, or fulfilled (no refund)
      expect(b.coins).toBe(b.ledgerCoins);
    });
  });

  describe('one-time awards', () => {
    it('pays the welcome bonus once, even when claimed concurrently', async () => {
      const u = await makeUser();
      await Promise.all(Array.from({ length: 5 }, () => users.claimWelcomeBonus(u)));
      expect(await balances(u)).toEqual({ xp: 50, coins: 100, ledgerXp: 50, ledgerCoins: 100 });
    });

    it('lets the starter challenge be completed once, paying at most the capped amount', async () => {
      const u = await makeUser();
      await makeQuestions(12, 'st');
      const first = await takeQuiz(u, 12, () => 'a');
      const second = await takeQuiz(u, 12, () => 'a');

      const res = await users.completeStarterChallenge(u, first.sessionId, first.answers);
      expect(res.earnedXp).toBe(100); // 10 correct x 10, capped at 10 rewarded answers
      await expect(
        users.completeStarterChallenge(u, second.sessionId, second.answers),
      ).rejects.toBeInstanceOf(ConflictException);

      const b = await balances(u);
      expect(b.xp).toBe(100);
      expect(b.xp).toBe(b.ledgerXp);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u } })).starterChallengeCompletedAt).not.toBeNull();
    });
  });

  describe('quiz sessions', () => {
    let pool: string[];
    beforeAll(async () => {
      pool = await makeQuestions(60, 'qz');
    });

    it('pays a session once and rejects replays, concurrent or not', async () => {
      const u = await makeUser();
      const s = await takeQuiz(u, 5, () => 'a');

      const attempts = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          quiz.submitQuizResults(u, { sessionId: s.sessionId, answers: s.answers, timeTaken: 10 }),
        ),
      );

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      const b = await balances(u);
      expect(b.xp).toBe(s.ids.length * 10);
      expect(b.xp).toBe(b.ledgerXp);
      expect(b.coins).toBe(b.ledgerCoins);
    });

    it('does not let a student submit answers for questions the server never issued', async () => {
      const u = await makeUser();
      const s = await takeQuiz(u, 3, () => 'b'); // all wrong
      const extra = pool.filter((id) => !s.ids.includes(id)).slice(0, 20);
      const stuffed = [
        ...s.answers,
        ...extra.map((id) => ({ questionId: id, selectedOptionId: `${id}_a` })), // correct, but not issued
      ];

      const res = await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers: stuffed, timeTaken: 5 });

      expect(res.correctAnswers).toBe(0);
      expect(res.earnedXp).toBe(0);
    });

    it('rejects someone else\'s session', async () => {
      const owner = await makeUser();
      const thief = await makeUser();
      const s = await takeQuiz(owner, 3, () => 'a');
      await expect(
        quiz.submitQuizResults(thief, { sessionId: s.sessionId, answers: s.answers, timeTaken: 5 }),
      ).rejects.toThrow();
      expect((await balances(thief)).xp).toBe(0);
    });

    it('does not pay again for the same questions in the same week', async () => {
      const u = await makeUser();
      await makeQuestions(1, 'one'); // ensure pool is not the only source
      const first = await takeQuiz(u, 50, () => 'a');
      const r1 = await quiz.submitQuizResults(u, { sessionId: first.sessionId, answers: first.answers, timeTaken: 5 });
      expect(r1.earnedXp).toBeGreaterThan(0);

      // Fresh session over the same bank, all correct again: nothing new to pay
      // for the questions already rewarded this week.
      const again = await takeQuiz(u, 50, () => 'a');
      const overlap = again.ids.filter((id) => first.ids.includes(id)).length;
      const r2 = await quiz.submitQuizResults(u, { sessionId: again.sessionId, answers: again.answers, timeTaken: 5 });
      expect(r2.earnedXp).toBeLessThanOrEqual((again.ids.length - overlap) * 10);
    });

    it('stops paying once the daily cap is reached', async () => {
      const u = await makeUser();
      let paid = 0;
      // Distinct questions each time: 61 in the bank, sessions of 50 then the rest.
      const seen = new Set<string>();
      for (let i = 0; i < 4 && paid < QUIZ_DAILY_REWARD_CAP + 100; i++) {
        const s = await takeQuiz(u, 50, () => 'a');
        s.ids.forEach((id) => seen.add(id));
        const r = await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers: s.answers, timeTaken: 5 });
        paid += r.earnedXp;
      }
      expect(paid).toBeLessThanOrEqual(QUIZ_DAILY_REWARD_CAP);
      const b = await balances(u);
      expect(b.xp).toBeLessThanOrEqual(QUIZ_DAILY_REWARD_CAP);
      expect(b.xp).toBe(b.ledgerXp);
    });

    it('locks the first answer, so a revealed answer cannot be re-submitted as right', async () => {
      const u = await makeUser();
      const s = await takeQuiz(u, 1, () => 'b'); // wrong on purpose
      const qid = s.ids[0];

      const first = await quiz.checkAnswer(u, s.sessionId, qid, `${qid}_b`);
      expect(first.correct).toBe(false);
      expect(first.correctOptionId).toBe(`${qid}_a`);

      // Now that the answer is known, retry the check and the submit with it.
      const retry = await quiz.checkAnswer(u, s.sessionId, qid, `${qid}_a`);
      expect(retry.correct).toBe(false);

      const res = await quiz.submitQuizResults(u, {
        sessionId: s.sessionId,
        answers: [{ questionId: qid, selectedOptionId: `${qid}_a` }],
        timeTaken: 5,
      });
      expect(res.correctAnswers).toBe(0);
      expect(res.earnedXp).toBe(0);
    });
  });

  describe('challenges', () => {
    const setup = async () => {
      const a = await makeUser();
      const b = await makeUser();
      const qs = await makeQuestions(3, `ch${n}`);
      const c = await prisma.challenge.create({
        data: {
          subjectId,
          classLevel: 'SS1',
          challengerId: a,
          opponentId: b,
          challengerTopics: [],
          opponentTopics: [],
          status: 'ACTIVE',
          questionIds: qs,
        },
      });
      const right = qs.map((q) => ({ questionId: q, selectedOptionId: `${q}_a` }));
      const wrong = qs.map((q) => ({ questionId: q, selectedOptionId: `${q}_b` }));
      return { a, b, c, qs, right, wrong };
    };

    it('grades a repeated answer once and lets a player submit once', async () => {
      const { a, c, qs } = await setup();
      const stuffed = Array.from({ length: 10 }, () => ({ questionId: qs[0], selectedOptionId: `${qs[0]}_a` }));

      const attempts = await Promise.allSettled([
        challenges.submitAnswers(a, c.id, stuffed),
        challenges.submitAnswers(a, c.id, stuffed),
      ]);

      expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.find((x) => x.status === 'rejected')).toMatchObject({
        reason: expect.any(BadRequestException),
      });
      const b = await balances(a);
      expect(b.xp).toBe(10); // one correct question, not ten
      expect(b.xp).toBe(b.ledgerXp);
    });

    it('completes once and pays the win bonus once when both submit simultaneously', async () => {
      const { a, b, c, right, wrong } = await setup();

      await Promise.all([
        challenges.submitAnswers(a, c.id, right),
        challenges.submitAnswers(b, c.id, wrong),
      ]);

      const done = await prisma.challenge.findUniqueOrThrow({ where: { id: c.id } });
      expect(done.status).toBe('COMPLETED');
      const winBonuses = await prisma.ledgerEntry.count({
        where: { reason: 'challenge_win', refId: c.id },
      });
      expect(winBonuses).toBe(2); // one XP row + one COIN row for the single winner
      const ba = await balances(a);
      expect(ba.xp).toBe(30 + 50); // 3 correct + win bonus
      expect(ba.xp).toBe(ba.ledgerXp);
      expect(ba.coins).toBe(ba.ledgerCoins);
    });
  });
});
