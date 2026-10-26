/**
 * Points leagues against a REAL Postgres: a fixed number of points per quiz, a
 * daily maximum that concurrent quizzes cannot exceed, ties to whoever reached
 * the total first, finalising and prizes. Skipped unless
 * TEST_DATABASE_URL points at a migrated, DISPOSABLE database (it deletes all
 * SS2 questions and every competition first).
 */
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { ActivityService } from '../src/modules/activity/activity.service';
import { AdminCompetitionResultsService } from '../src/modules/admin/admin-competition-results.service';
import { AdminCompetitionsService } from '../src/modules/admin/admin-competitions.service';
import { AuditService } from '../src/modules/admin/audit.service';
import { CertificatesService } from '../src/modules/certificates/certificates.service';
import { CompetitionSittingsService } from '../src/modules/competitions/competition-sittings.service';
import { CompetitionsService } from '../src/modules/competitions/competitions.service';
import { PrizesService } from '../src/modules/competitions/prizes.service';
import { AchievementsService } from '../src/modules/gamification/achievements.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { AttemptsService } from '../src/modules/progress/attempts.service';
import { QuizService } from '../src/modules/quiz/quiz.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('points league (real database)', () => {
  let prisma: PrismaService;
  let admin: AdminCompetitionsService;
  let results: AdminCompetitionResultsService;
  let comps: CompetitionsService;
  let sittings: CompetitionSittingsService;
  let prizes: PrizesService;
  let certificates: CertificatesService;
  let quiz: QuizService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `lg${Date.now()}`;
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
  const ledgerSums = async (id: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    const sum = async (c: 'XP' | 'COIN') => (await prisma.ledgerEntry.aggregate({ where: { userId: id, currency: c }, _sum: { amount: true } }))._sum.amount ?? 0;
    return { xp: u.xp, ledgerXp: await sum('XP'), coins: u.coins, ledgerCoins: await sum('COIN') };
  };

  const answersFor = async (sessionId: string, wrongCount = 0) => {
    const s = await prisma.quizSession.findUniqueOrThrow({ where: { id: sessionId } });
    const qs = await prisma.question.findMany({ where: { id: { in: s.questionIds } } });
    const byId = new Map(qs.map((q) => [q.id, q]));
    const ordered = [...s.questionIds].sort(); // wrong answers hit the same questions for everyone who asks for them
    return ordered.map((id, i) => ({ questionId: id, selectedOptionId: i < wrongCount ? `${id}_b` : byId.get(id)!.correctAnswerId }));
  };

  /** Starts, then submits (unless `leaveOpen`) as if the student had begun `secondsAgo` ago. */
  const sit = async (c: string, u: string, o: { wrong?: number; secondsAgo?: number; leaveOpen?: boolean; lockOnly?: number } = {}) => {
    const start = await comps.start(u, c);
    await prisma.quizSession.update({ where: { id: start.sessionId }, data: { createdAt: new Date(Date.now() - (o.secondsAgo ?? 100) * 1000) } });
    const answers = await answersFor(start.sessionId, o.wrong ?? 0);
    const toLock = o.lockOnly ?? answers.length;
    for (const a of answers.slice(0, toLock)) await quiz.checkAnswer(u, start.sessionId, a.questionId, a.selectedOptionId);
    if (o.leaveOpen) return start.sessionId;
    return quiz.submitQuizResults(u, { sessionId: start.sessionId, answers: answers.slice(0, toLock), timeTaken: 5 });
  };

  const newCompetition = async (over: Record<string, unknown> = {}) => {
    const c = await admin.create(adminId, {
      title: `${tag} ${++n}`, subtitle: 's', type: 'MONTHLY', questionCount: 5, subjectIds: [subjectId], classLevels: ['SS2'],
      startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 8 * day).toISOString(),
      claimDeadlineDays: 7,
      prizes: [
        { positionFrom: 1, positionTo: 1, title: '500 coins', kind: 'COINS', coinAmount: 500 },
        { positionFrom: 2, positionTo: 3, title: '1GB data', kind: 'DATA' },
        { positionFrom: 4, positionTo: 4, title: 'Tablet', kind: 'DEVICE' },
      ],
      ...over,
    } as any);
    await admin.publish(adminId, c.id);
    await prisma.competition.update({ where: { id: c.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
    return c.id;
  };
  const close = (id: string) => prisma.competition.update({ where: { id }, data: { startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - 1000), status: 'CLOSED' } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    const ledger = new LedgerService(prisma);
    const audit = new AuditService(prisma);
    sittings = new CompetitionSittingsService(prisma, ledger);
    const notifications = { notify } as any;
    const achievements = new AchievementsService(prisma, ledger, notifications);
    quiz = new QuizService(prisma, new ActivityService(prisma), ledger, new AttemptsService(prisma), { evaluate: async () => [] } as any, sittings);
    admin = new AdminCompetitionsService(prisma, audit);
    results = new AdminCompetitionResultsService(prisma, audit, quiz, notifications, achievements);
    comps = new CompetitionsService(prisma, notifications, sittings);
    prizes = new PrizesService(prisma, ledger, notifications);
    certificates = new CertificatesService(prisma, notifications, achievements);
    await prisma.competition.deleteMany({});
    await prisma.question.deleteMany({ where: { classLevel: 'SS2' } });
    await prisma.subject.create({ data: { id: subjectId, name: tag, icon: 'i', color: '#000' } });
    for (let i = 0; i < 8; i++) {
      const id = `${tag}-q${i}`;
      await prisma.question.create({
        data: { id, subjectId, classLevel: 'SS2', questionText: `Question ${i}`, correctAnswerId: `${id}_a`, status: 'PUBLISHED',
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

  /** A student finishes a practice quiz of `n` questions, all correct. */
  const practise = async (u: string, n = 5) => {
    const qs = await quiz.getRandomQuestions(u, subjectId, n, 'SS2' as any);
    return quiz.submitQuizResults(u, { sessionId: qs[0].sessionId, answers: qs.map((q: any) => ({ questionId: q.id, selectedOptionId: `${q.id}_a` })), timeTaken: 5 });
  };
  const newLeague = async (over: Record<string, unknown> = {}) => {
    const c = await admin.create(adminId, {
      title: `${tag} league ${++n}`, subtitle: 's', type: 'MONTHLY', format: 'POINTS_LEAGUE', pointsPerQuiz: 10, dailyPointsCap: 25,
      subjectIds: [subjectId], classLevels: ['SS2'],
      startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 8 * day).toISOString(),
      prizes: [{ positionFrom: 1, positionTo: 1, title: '500 coins', kind: 'COINS', coinAmount: 500 }],
      ...over,
    } as any);
    await admin.publish(adminId, c.id);
    await prisma.competition.update({ where: { id: c.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
    return c.id;
  };
  const points = async (c: string, u: string) => (await prisma.competitionParticipant.findUniqueOrThrow({ where: { competitionId_userId: { competitionId: c, userId: u } } })).score;
  const sumEntries = async (c: string, u: string) => (await prisma.competitionPointsEntry.aggregate({ where: { competitionId: c, userId: u }, _sum: { points: true } }))._sum.points ?? 0;

  describe('setting one up', () => {
    it('needs points per quiz, a sensible daily maximum and no timer, and needs no questions to publish', async () => {
      const base = { title: `${tag} bad`, subtitle: 's', type: 'MONTHLY', format: 'POINTS_LEAGUE', startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 8 * day).toISOString() } as any;
      await expect(admin.create(adminId, base)).rejects.toThrow(/points each quiz earns/);
      await expect(admin.create(adminId, { ...base, pointsPerQuiz: 10, dailyPointsCap: 5 })).rejects.toThrow(/at least the points of one quiz/);
      await expect(admin.create(adminId, { ...base, pointsPerQuiz: 10, timeLimitMinutes: 10 })).rejects.toThrow(/not timed/);
      await expect(admin.create(adminId, { ...base, format: 'FIXED_SET' })).rejects.toThrow(/question count/);
      const ok = await admin.create(adminId, { ...base, pointsPerQuiz: 10, dailyPointsCap: 30 });
      expect(ok).toMatchObject({ format: 'POINTS_LEAGUE', pointsPerQuiz: 10, dailyPointsCap: 30, minQuestionsPerQuiz: 5, questionCount: null });
      const published = await admin.publish(adminId, ok.id);
      expect(published).toMatchObject({ status: 'PUBLISHED', questionsFrozen: false });
    });
  });

  describe('earning points', () => {
    let c: string;
    let a: string;

    beforeAll(async () => {
      c = await newLeague();
      a = await makeUser();
      await comps.join(a, c);
    });

    it('pays a fixed amount per quiz up to the daily maximum, trimming the last, then nothing', async () => {
      const earned: number[] = [];
      for (let i = 0; i < 4; i++) earned.push(((await practise(a)) as any).leagues?.[0]?.pointsEarned);
      expect(earned).toEqual([10, 10, 5, 0]); // cap 25
      expect(await points(c, a)).toBe(25);
      expect(await sumEntries(c, a)).toBe(25);
      expect((await comps.detail(a, c)).league).toMatchObject({ pointsToday: 25, pointsLeftToday: 0, pointsPerQuiz: 10 });
    });

    it('starts a fresh allowance the next day', async () => {
      const tomorrow = new Date(Date.now() + day);
      const qs = await quiz.getRandomQuestions(a, subjectId, 5, 'SS2' as any);
      const r = await sittings.recordLeaguePoints(a, { sessionId: qs[0].sessionId, questionCount: 5, subjectIds: [subjectId] }, tomorrow);
      expect(r[0]).toMatchObject({ pointsEarned: 10, pointsToday: 10 });
      expect(await points(c, a)).toBe(35);
    });

    it('counts a quiz session only once', async () => {
      const qs = await quiz.getRandomQuestions(a, subjectId, 5, 'SS2' as any);
      const input = { sessionId: qs[0].sessionId, questionCount: 5, subjectIds: [subjectId] };
      const later = new Date(Date.now() + 2 * day);
      expect((await sittings.recordLeaguePoints(a, input, later))[0].pointsEarned).toBe(10);
      expect(await sittings.recordLeaguePoints(a, input, later)).toEqual([]);
      expect(await points(c, a)).toBe(45);
      expect(await sumEntries(c, a)).toBe(45);
    });

    it('ignores quizzes that are too short, in another subject, or taken before joining', async () => {
      const b = await makeUser();
      await practise(b); // not joined
      expect(await prisma.competitionPointsEntry.count({ where: { userId: b } })).toBe(0);
      await comps.join(b, c);
      expect(((await practise(b, 4)) as any).leagues).toBeUndefined(); // 4 < 5 questions
      const other = await sittings.recordLeaguePoints(b, { sessionId: 'x', questionCount: 10, subjectIds: ['some-other-subject'] });
      expect(other).toEqual([]);
      expect(await points(c, b)).toBeNull();
    });

    it('cannot be started like a sitting', async () => {
      await expect(comps.start(a, c)).rejects.toThrow(/points league/);
    });
  });

  describe('the daily maximum under pressure', () => {
    it('holds when one student finishes several quizzes at the same moment', async () => {
      const c = await newLeague({ dailyPointsCap: 25 });
      const u = await makeUser();
      await comps.join(u, c);
      const sessions = await Promise.all(Array.from({ length: 6 }, () => quiz.getRandomQuestions(u, subjectId, 5, 'SS2' as any)));
      const results = await Promise.allSettled(
        sessions.map((qs: any[]) => quiz.submitQuizResults(u, { sessionId: qs[0].sessionId, answers: qs.map((q) => ({ questionId: q.id, selectedOptionId: `${q.id}_a` })), timeTaken: 5 })),
      );
      expect(results.filter((r) => r.status === 'rejected').map((r: any) => String(r.reason?.message).slice(0, 80))).toEqual([]);
      expect(await points(c, u)).toBe(25);
      expect(await sumEntries(c, u)).toBe(25);
      expect(await prisma.competitionPointsEntry.count({ where: { competitionId: c, userId: u } })).toBe(6);
    });
  });

  describe('ranking and results', () => {
    let c: string;
    let [first, third, second, nobody, cheat]: string[] = [];

    beforeAll(async () => {
      c = await newLeague({ dailyPointsCap: 100 });
      [first, third, second, nobody, cheat] = await Promise.all(Array.from({ length: 5 }, () => makeUser()));
      for (const u of [first, third, second, nobody, cheat]) await comps.join(u, c);
      // `first` reaches 20 points, then `third` reaches the same 20, so `first` leads on the tie-break.
      await practise(first); await practise(first);
      await practise(third); await practise(third);
      await practise(second);
      for (let i = 0; i < 3; i++) await practise(cheat); // 30 points: would win
    });

    it('ranks by total points, with level totals going to whoever got there first, and leaves out the unscored', async () => {
      const board = await comps.leaderboard(first, c);
      expect(board).toMatchObject({ format: 'POINTS_LEAGUE', metric: 'Points', scored: 4 });
      expect(board.top.map((r: any) => [r.points, r.isMe])).toEqual([[30, false], [20, true], [20, false], [10, false]]);
      expect((board as any).me).toMatchObject({ rank: 2, points: 20 });
      expect(JSON.stringify(board)).not.toContain('Stu Dent'.toLowerCase() + '5'); // names are first name + initial only
    });

    it('finalises: disqualified entrants drop out, the rest are ranked, and the winner gets the prize', async () => {
      await prisma.competition.update({ where: { id: c }, data: { startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - 1000), status: 'CLOSED' } });
      const v = await results.validate(adminId, c);
      expect(v).toMatchObject({ settledSittings: 0, newlyFlagged: 0 });
      await results.disqualify(adminId, c, cheat, 'Used another account');
      const done = await results.finalise(adminId, c);
      expect(done).toMatchObject({ status: 'FINALISED', ranked: 3, awards: 1 });
      const ranks = await prisma.competitionParticipant.findMany({ where: { competitionId: c, status: 'COMPLETED' }, orderBy: { rank: 'asc' }, select: { userId: true, rank: true, score: true } });
      expect(ranks).toEqual([{ userId: first, rank: 1, score: 20 }, { userId: third, rank: 2, score: 20 }, { userId: second, rank: 3, score: 10 }]);
      expect((await prisma.prizeAward.findFirstOrThrow({ where: { competitionId: c } })).userId).toBe(first);
      expect(await prisma.certificate.count({ where: { competitionId: c, kind: 'WINNER', userId: first } })).toBe(1);
    });
  });
});
