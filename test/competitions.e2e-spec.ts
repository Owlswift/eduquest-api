/**
 * Competitions against a REAL Postgres: the lifecycle, eligibility, fair
 * scoring, the deadline and answer-secrecy rules, and one-time payouts.
 * Skipped unless TEST_DATABASE_URL points at a migrated, DISPOSABLE database
 * (it deletes all SS2 questions and every competition first).
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { ActivityService } from '../src/modules/activity/activity.service';
import { AdminCompetitionsService } from '../src/modules/admin/admin-competitions.service';
import { AuditService } from '../src/modules/admin/audit.service';
import { CompetitionSittingsService } from '../src/modules/competitions/competition-sittings.service';
import { CompetitionsService } from '../src/modules/competitions/competitions.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { AttemptsService } from '../src/modules/progress/attempts.service';
import { QuizService } from '../src/modules/quiz/quiz.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('competitions (real database)', () => {
  let prisma: PrismaService;
  let admin: AdminCompetitionsService;
  let comps: CompetitionsService;
  let quiz: QuizService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `cp${Date.now()}`;
  const subjectId = `${tag}-subj`;
  const userIds: string[] = [];
  let adminId: string;
  let n = 0;
  const day = 86_400_000;

  const makeUser = async (over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `Stu Dent${n}`, username: id, email: `${id}@t.test`, classLevel: 'SS2', age: '19', state: 'Lagos', ...over } });
    userIds.push(id);
    return id;
  };

  /** Draft -> published, then moved so it is running now. */
  const runningCompetition = async (over: Record<string, unknown> = {}, started = true) => {
    const c = await admin.create(adminId, {
      title: `${tag} ${++n}`, subtitle: 's', type: 'MONTHLY', questionCount: 5, subjectIds: [subjectId], classLevels: ['SS2'],
      startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 8 * day).toISOString(),
      prizes: [{ positionFrom: 1, positionTo: 1, title: 'Tablet', kind: 'DEVICE' }],
      ...over,
    } as any);
    await admin.publish(adminId, c.id);
    if (started) await prisma.competition.update({ where: { id: c.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
    return c.id;
  };

  const answersFor = async (sessionId: string, wrongCount = 0, skip = 0) => {
    const s = await prisma.quizSession.findUniqueOrThrow({ where: { id: sessionId } });
    const qs = await prisma.question.findMany({ where: { id: { in: s.questionIds } } });
    const byId = new Map(qs.map((q) => [q.id, q]));
    return s.questionIds.slice(0, s.questionIds.length - skip).map((id, i) => ({
      questionId: id,
      selectedOptionId: i < wrongCount ? `${id}_b` : byId.get(id)!.correctAnswerId,
    }));
  };

  /** Sit and submit, as if the student started `secondsAgo` ago. */
  const sit = async (c: string, u: string, o: { wrong?: number; skip?: number; secondsAgo?: number } = {}) => {
    const start = await comps.start(u, c);
    const sessionId = start.sessionId;
    await prisma.quizSession.update({ where: { id: sessionId }, data: { createdAt: new Date(Date.now() - (o.secondsAgo ?? 60) * 1000) } });
    const answers = await answersFor(sessionId, o.wrong ?? 0, o.skip ?? 0);
    for (const a of answers) await quiz.checkAnswer(u, sessionId, a.questionId, a.selectedOptionId);
    return quiz.submitQuizResults(u, { sessionId, answers, timeTaken: 10 });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    const ledger = new LedgerService(prisma);
    const audit = new AuditService(prisma);
    const sittings = new CompetitionSittingsService(prisma, ledger);
    admin = new AdminCompetitionsService(prisma, audit);
    comps = new CompetitionsService(prisma, { notify } as any, sittings);
    quiz = new QuizService(prisma, new ActivityService(prisma), ledger, new AttemptsService(prisma), { evaluate: async () => [] } as any, sittings);
    await prisma.competition.deleteMany({});
    await prisma.dailyChallenge.deleteMany({});
    await prisma.question.deleteMany({ where: { classLevel: 'SS2' } });
    await prisma.subject.create({ data: { id: subjectId, name: tag, icon: 'i', color: '#000' } });
    for (let i = 0; i < 12; i++) {
      const id = `${tag}-q${i}`;
      await prisma.question.create({
        data: { id, subjectId, classLevel: 'SS2', questionText: `Question ${i}`, correctAnswerId: `${id}_a`, status: 'PUBLISHED', explanation: `Because ${i}`,
          options: { create: [{ id: `${id}_a`, text: 'A' }, { id: `${id}_b`, text: 'B' }] } },
      });
    }
    adminId = await makeUser({ role: 'ADMIN' });
  });

  afterAll(async () => {
    await prisma.competition.deleteMany({});
    await prisma.adminAuditLog.deleteMany({ where: { adminId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.question.deleteMany({ where: { classLevel: 'SS2' } });
    await prisma.subject.delete({ where: { id: subjectId } });
    await prisma.$disconnect();
  });

  describe('publishing', () => {
    it('freezes five published questions from the requested subject and class', async () => {
      const id = await runningCompetition({}, false);
      const c = await prisma.competition.findUniqueOrThrow({ where: { id } });
      expect(c.status).toBe('PUBLISHED');
      expect(c.questionIds).toHaveLength(5);
      expect(new Set(c.questionIds).size).toBe(5);
      const qs = await prisma.question.findMany({ where: { id: { in: c.questionIds } } });
      expect(qs.every((q) => q.subjectId === subjectId && q.classLevel === 'SS2' && q.status === 'PUBLISHED')).toBe(true);
    });

    it('does not publish when the bank is too small', async () => {
      const c = await admin.create(adminId, {
        title: `${tag} big`, subtitle: 's', type: 'MONTHLY', questionCount: 60, subjectIds: [subjectId],
        startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 5 * day).toISOString(),
      } as any);
      await expect(admin.publish(adminId, c.id)).rejects.toThrow(/Only 12 published questions match, but the competition needs 60/);
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('DRAFT');
    });

    it('publishes once even when two admins click at the same time', async () => {
      const c = await admin.create(adminId, {
        title: `${tag} race`, subtitle: 's', type: 'MONTHLY', questionCount: 5, subjectIds: [subjectId],
        startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 5 * day).toISOString(),
      } as any);
      const results = await Promise.allSettled([admin.publish(adminId, c.id), admin.publish(adminId, c.id)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('hides drafts from students and shows a published competition as upcoming until it starts', async () => {
      const draft = await admin.create(adminId, {
        title: `${tag} draft`, subtitle: 's', type: 'MONTHLY', questionCount: 5,
        startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 5 * day).toISOString(),
      } as any);
      const upcoming = await runningCompetition({}, false);
      const u = await makeUser();
      const list = await comps.list(u);
      expect(list.find((c) => c.id === draft.id)).toBeUndefined();
      expect(list.find((c) => c.id === upcoming)).toMatchObject({ status: 'upcoming', lifecycle: 'PUBLISHED', eligible: true });
      await expect(comps.detail(u, draft.id)).rejects.toThrow(/not found/);
      await expect(comps.start(u, upcoming)).rejects.toThrow(/opens/);
    });
  });

  describe('a sitting', () => {
    it('gives every entrant the same questions, hides all answers, and reveals nothing while it runs', async () => {
      const c = await runningCompetition();
      const [a, b] = [await makeUser(), await makeUser()];
      const sa = await comps.start(a, c);
      const sb = await comps.start(b, c);

      expect(sa.questions.map((q) => q.id).sort()).toEqual(sb.questions.map((q) => q.id).sort());
      expect(sa.questions).toHaveLength(5);
      expect(JSON.stringify(sa)).not.toMatch(/Because|correctAnswerId/); // no explanations, no key

      const q = sa.questions[0];
      const lock = await quiz.checkAnswer(a, sa.sessionId, q.id, q.options[0].id);
      expect(lock).toEqual({ locked: true }); // never says right or wrong
      await expect(comps.review(a, c)).rejects.toThrow(/closed/); // answers wait until it closes
    });

    it('scores a sitting, ranks by score then speed, and puts unfinished students nowhere', async () => {
      const c = await runningCompetition();
      const [fast, slow, partial, unfinished] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
      const r1 = await sit(c, fast, { secondsAgo: 60 });
      const r2 = await sit(c, slow, { secondsAgo: 200 });
      const r3 = await sit(c, partial, { wrong: 2, secondsAgo: 30 });
      await comps.start(unfinished, c); // started, never finished

      expect(r1.competition).toMatchObject({ score: 5, correct: 5, wrong: 0, rank: 1 });
      expect(r2.competition).toMatchObject({ score: 5, rank: 2 }); // same score, slower
      expect(r3.competition).toMatchObject({ score: 3, wrong: 2 });
      expect(r3.competition!.rank).toBe(3);

      const board = await comps.leaderboard(slow, c);
      expect(board).toMatchObject({ format: 'FIXED_SET', completed: 3, entered: 4, final: false });
      expect(board.top.map((e: any) => e.score)).toEqual([5, 5, 3]);
      expect(board.top.map((e: any) => e.rank)).toEqual([1, 2, 3]);
      expect(board.top.map((e: any) => e.isMe)).toEqual([false, true, false]);
      expect(board.me).toMatchObject({ rank: 2, score: 5 });
      expect(board.top[0].name).toMatch(/^Stu D\.$/); // first name and initial only
      expect(JSON.stringify(board)).not.toMatch(/@t\.test/);
      expect(await comps.leaderboard(unfinished, c).then((b: any) => b.me)).toBeNull();
    });

    it('applies disclosed points and wrong-answer penalties, and never goes below zero', async () => {
      const c = await runningCompetition({ pointsPerCorrect: 3, penaltyPerWrong: 2 });
      const [a, b] = [await makeUser(), await makeUser()];
      const ra = await sit(c, a, { wrong: 1 }); // 4 right, 1 wrong: 12 - 2
      expect(ra.competition!.score).toBe(10);
      const rb = await sit(c, b, { wrong: 5 }); // all wrong: 0 - 10 floors at 0
      expect(rb.competition!.score).toBe(0);
    });

    it('does not penalise questions left unanswered', async () => {
      const c = await runningCompetition({ penaltyPerWrong: 1 });
      const u = await makeUser();
      const r = await sit(c, u, { skip: 2 }); // 3 right, 2 skipped
      expect(r.competition).toMatchObject({ score: 3, correct: 3, wrong: 0 });
    });

    it('lets a student sit only once, even with simultaneous taps', async () => {
      const c = await runningCompetition();
      const u = await makeUser();
      const starts = await Promise.allSettled([comps.start(u, c), comps.start(u, c), comps.start(u, c)]);
      const failures = starts.flatMap((r: any) => (r.status === 'rejected' ? [String(r.reason?.message ?? r.reason).slice(0, 200)] : []));
      expect(failures).toEqual([]); // every tap gets the same open sitting
      expect(new Set(starts.map((s: any) => s.value.sessionId)).size).toBe(1);
      expect(await prisma.quizSession.count({ where: { userId: u, competitionId: c } })).toBe(1);

      const sessionId = (starts[0] as any).value.sessionId;
      const answers = await answersFor(sessionId);
      const submits = await Promise.allSettled([1, 2, 3].map(() => quiz.submitQuizResults(u, { sessionId, answers, timeTaken: 5 })));
      expect(submits.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      await expect(comps.start(u, c)).rejects.toBeInstanceOf(ConflictException);
    });

    it('pays the participation reward once, through the ledger', async () => {
      const c = await runningCompetition({ participationXp: 25, participationCoins: 10 });
      const u = await makeUser();
      const r = await sit(c, u);
      expect(r.earnedXp).toBe(25);
      expect(r.earnedCoins).toBe(10);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: u } });
      const rows = await prisma.ledgerEntry.findMany({ where: { userId: u } });
      expect(user.xp).toBe(rows.filter((x) => x.currency === 'XP').reduce((s, x) => s + x.amount, 0));
      expect(user.coins).toBe(rows.filter((x) => x.currency === 'COIN').reduce((s, x) => s + x.amount, 0));
      expect(rows.map((x) => x.reason)).toEqual(expect.arrayContaining(['competition_participation']));
      expect(rows.some((x) => x.reason === 'quiz')).toBe(false); // no per-question quiz rewards
    });

    it('raises a review flag for an impossibly fast sitting and fingerprints the answer sheet', async () => {
      const c = await runningCompetition();
      const u = await makeUser();
      await sit(c, u, { secondsAgo: 3 }); // 5 answers in 3 seconds
      const entry = await prisma.competitionParticipant.findUniqueOrThrow({ where: { competitionId_userId: { competitionId: c, userId: u } } });
      expect(entry.flags).toEqual(['TOO_FAST']);
      expect(entry.answerHash).toMatch(/^[0-9a-f]{32}$/);
      expect(entry.status).toBe('COMPLETED');
    });
  });

  describe('deadlines', () => {
    it('refuses answers locked after the student time limit and ignores a late submission body', async () => {
      const c = await runningCompetition({ timeLimitMinutes: 10 });
      const u = await makeUser();
      const s = await comps.start(u, c);
      const answers = await answersFor(s.sessionId);
      // Two answers locked in time...
      await quiz.checkAnswer(u, s.sessionId, answers[0].questionId, answers[0].selectedOptionId);
      await quiz.checkAnswer(u, s.sessionId, answers[1].questionId, answers[1].selectedOptionId);
      // ...then the limit passes.
      await prisma.quizSession.update({ where: { id: s.sessionId }, data: { createdAt: new Date(Date.now() - 20 * 60_000), expiresAt: new Date(Date.now() - 10 * 60_000) } });

      await expect(quiz.checkAnswer(u, s.sessionId, answers[2].questionId, answers[2].selectedOptionId)).rejects.toThrow(/Time is up/);
      const r = await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers, timeTaken: 5 }); // body is late
      expect(r.competition).toMatchObject({ correct: 2, score: 2 });
      expect(r.competition!.timeTakenSec).toBe(600); // counted up to the deadline, not beyond
    });

    it('stops everyone when an admin closes the competition early', async () => {
      const c = await runningCompetition();
      const u = await makeUser();
      const s = await comps.start(u, c);
      const answers = await answersFor(s.sessionId);
      await quiz.checkAnswer(u, s.sessionId, answers[0].questionId, answers[0].selectedOptionId);

      const closed = await admin.closeNow(adminId, c, 'A question had the wrong key');
      expect(closed.status).toBe('CLOSED');
      await expect(quiz.checkAnswer(u, s.sessionId, answers[1].questionId, answers[1].selectedOptionId)).rejects.toThrow(/Time is up/);
      await expect(comps.start(await makeUser(), c)).rejects.toThrow(/closed/);
      // A minute later (beyond the network grace) the client sends everything it has.
      await prisma.competition.update({ where: { id: c }, data: { endsAt: new Date(Date.now() - 60_000) } });
      const r = await quiz.submitQuizResults(u, { sessionId: s.sessionId, answers, timeTaken: 5 });
      expect(r.competition).toMatchObject({ correct: 1 }); // only what was locked in time
    });

    it('moves to ACTIVE and CLOSED with the clock, and shows answers only once closed', async () => {
      const c = await runningCompetition();
      const u = await makeUser();
      expect((await comps.detail(u, c)).lifecycle).toBe('ACTIVE');
      await sit(c, u);
      await expect(comps.review(u, c)).rejects.toThrow(/closed/);

      await prisma.competition.update({ where: { id: c }, data: { startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - 1000) } });
      expect((await comps.detail(u, c)).lifecycle).toBe('CLOSED');
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: c } })).status).toBe('CLOSED'); // persisted
      const review = await comps.review(u, c);
      expect(review.items).toHaveLength(5);
      expect(review.items.every((i) => i.correct && i.explanation?.startsWith('Because'))).toBe(true);
      await expect(comps.join(await makeUser(), c)).rejects.toThrow(/already ended/);
    });
  });

  describe('eligibility', () => {
    it('lets in only the class levels it names', async () => {
      const c = await runningCompetition({ classLevels: ['SS2'] });
      const ss1 = await makeUser({ classLevel: 'SS1' });
      const ss2 = await makeUser({ classLevel: 'SS2' });
      await expect(comps.join(ss1, c)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(comps.start(ss1, c)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await comps.list(ss1)).find((x) => x.id === c)).toMatchObject({ eligible: false, ineligibleReason: expect.stringMatching(/SS2.*SS1/) });
      await expect(comps.join(ss2, c)).resolves.toEqual({ joined: true });
      expect(await prisma.competitionParticipant.count({ where: { competitionId: c, userId: ss1 } })).toBe(0);
    });

    it('limits a state competition to students who represent that state, however it was typed', async () => {
      const c = await runningCompetition({ type: 'STATE', state: 'Lagos' });
      await expect(comps.join(await makeUser({ state: 'Kano' }), c)).rejects.toThrow(/representing Lagos/);
      await expect(comps.join(await makeUser({ state: null }), c)).rejects.toThrow(/Set your state/);
      await expect(comps.join(await makeUser({ state: 'lagos' }), c)).resolves.toEqual({ joined: true });
    });

    it('limits a regional competition to the zone', async () => {
      const c = await runningCompetition({ type: 'REGIONAL', region: 'NORTH_WEST' });
      await expect(comps.join(await makeUser({ state: 'Lagos' }), c)).rejects.toThrow(/North West/);
      await expect(comps.join(await makeUser({ state: 'Kano' }), c)).resolves.toEqual({ joined: true });
      await expect(comps.join(await makeUser({ state: 'Sokoto' }), c)).resolves.toEqual({ joined: true });
    });
  });

  describe('older XP-window competitions', () => {
    it('still ranks by XP earned in the window, in a single query', async () => {
      const c = await prisma.competition.create({
        data: { title: `${tag} legacy`, subtitle: 's', prizes: ['x'], startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() + 3 * day), format: 'XP_WINDOW', status: 'PUBLISHED' },
      });
      const [a, b, late] = [await makeUser(), await makeUser(), await makeUser()];
      const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      const ago = (n: number) => new Date(today.getTime() - n * day);
      for (const u of [a, b, late]) await prisma.competitionParticipant.create({ data: { competitionId: c.id, userId: u, joinedAt: u === late ? new Date() : ago(3) } });
      await prisma.dailyActivity.createMany({
        data: [
          { userId: a, date: ago(2), xpEarned: 100 }, { userId: a, date: today, xpEarned: 50 },
          { userId: b, date: ago(1), xpEarned: 120 },
          { userId: b, date: ago(10), xpEarned: 999 }, // before the window: ignored
          { userId: late, date: ago(2), xpEarned: 500 }, // before they joined: ignored
          { userId: late, date: today, xpEarned: 10 },
        ],
      });
      const board: any = await comps.leaderboard(b, c.id);
      expect(board.format).toBe('XP_WINDOW');
      expect(board.top.map((e: any) => [e.xpEarned, e.isMe])).toEqual([[150, false], [120, true], [10, false]]);
      expect(board.me.rank).toBe(2);
    });
  });
});
