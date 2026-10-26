/**
 * Leaderboards against a REAL Postgres: the SQL ranking, scopes, rolling
 * windows, ties, subject boards, and that the viewer's own position is always
 * fresh. Skipped unless TEST_DATABASE_URL points at a migrated, DISPOSABLE
 * database (it zeroes every other user's XP and clears their daily activity so
 * the national boards are deterministic).
 */
import { PrismaService } from '../src/database/prisma.service';
import { CacheService } from '../src/common/cache/cache.service';
import { LeaderboardsService } from '../src/modules/leaderboards/leaderboards.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('leaderboards (real database)', () => {
  let prisma: PrismaService;
  let boards: LeaderboardsService;
  const tag = `lb${Date.now()}`;
  const subjectId = `${tag}-subj`;
  const otherSubject = `${tag}-oth`;
  const userIds: string[] = [];
  let n = 0;
  const day = 86_400_000;
  const today = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const ago = (days: number) => new Date(today().getTime() - days * day);

  const make = async (xp: number, over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `Stu Dent${n}`, username: id, email: `${id}@t.test`, xp, state: 'Lagos', classLevel: 'SS2', createdAt: new Date(Date.now() - (1000 - n) * 1000), ...over } });
    userIds.push(id);
    return id;
  };
  const ranksOf = (b: any) => b.entries.map((e: any) => [e.rank, e.score]);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    boards = new LeaderboardsService(prisma, new CacheService());
    await prisma.dailyActivity.deleteMany({});
    await prisma.subjectStat.deleteMany({});
    await prisma.user.updateMany({ data: { xp: 0 } });
    await prisma.subject.createMany({ data: [{ id: subjectId, name: `Maths ${tag}`, icon: 'i', color: '#000' }, { id: otherSubject, name: `Other ${tag}`, icon: 'i', color: '#000' }] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.subject.deleteMany({ where: { id: { in: [subjectId, otherSubject] } } });
    await prisma.$disconnect();
  });

  describe('lifetime XP', () => {
    let ids: Record<string, string>;
    beforeAll(async () => {
      ids = {
        top: await make(5000),
        tieA: await make(3000), // earlier signup wins a tie on the list, but they share a rank
        tieB: await make(3000),
        kano: await make(2500, { state: 'Kano', classLevel: 'SS3' }),
        ogun: await make(2000, { state: 'Ogun', classLevel: 'SS2' }),
        sokoto: await make(1500, { state: 'Sokoto', classLevel: 'SS1' }),
        lagosLow: await make(100, { state: 'Lagos', classLevel: 'SS2' }),
        zero: await make(0),
        admin: await make(9999, { role: 'ADMIN' }),
      };
    });

    it('ranks the whole country by XP, tied students share a rank, and zero-XP students and admins are left out', async () => {
      const b: any = await boards.board(ids.top, { scope: 'national', period: 'all', limit: 50 });
      expect(b.title).toBe('Lifetime XP · Nigeria');
      expect(ranksOf(b)).toEqual([[1, 5000], [2, 3000], [2, 3000], [4, 2500], [5, 2000], [6, 1500], [7, 100]]);
      expect(b.entries[1].isMe).toBe(false);
      expect(b.me).toMatchObject({ rank: 1, score: 5000 });
      expect(b.entries.some((e: any) => e.name === 'Stu D.')).toBe(true);
    });

    it('reports a viewer below the top list with their true rank, and tied viewers share it', async () => {
      const b: any = await boards.board(ids.lagosLow, { scope: 'national', period: 'all', limit: 3 });
      expect(b.entries).toHaveLength(3);
      expect(b.entries.some((e: any) => e.isMe)).toBe(false);
      expect(b.me).toMatchObject({ rank: 7, score: 100 });
      expect((await boards.board(ids.tieB, { scope: 'national', period: 'all', limit: 1 })).me!.rank).toBe(2);
    });

    it('has no position for someone with no XP', async () => {
      expect((await boards.board(ids.zero, { scope: 'national', period: 'all', limit: 5 })).me).toBeNull();
    });

    it('limits a state board to that state, and a student can look at another state', async () => {
      const lagos: any = await boards.board(ids.top, { scope: 'state', period: 'all', limit: 50 });
      expect(lagos.title).toBe('Lifetime XP · Lagos');
      expect(ranksOf(lagos)).toEqual([[1, 5000], [2, 3000], [2, 3000], [4, 100]]);
      const kano: any = await boards.board(ids.top, { scope: 'state', period: 'all', state: 'kano', limit: 50 });
      expect(ranksOf(kano)).toEqual([[1, 2500]]);
      expect(kano.me).toBeNull(); // not a Kano student
    });

    it('limits a zone board to its states', async () => {
      const sw: any = await boards.board(ids.top, { scope: 'region', period: 'all', limit: 50 });
      expect(sw.title).toBe('Lifetime XP · South West');
      expect(ranksOf(sw)).toEqual([[1, 5000], [2, 3000], [2, 3000], [4, 2000], [5, 100]]); // Lagos + Ogun
      const nw: any = await boards.board(ids.top, { scope: 'region', period: 'all', region: 'NORTH_WEST' as any, limit: 50 });
      expect(ranksOf(nw)).toEqual([[1, 2500], [2, 1500]]); // Kano and Sokoto are both North West
    });

    it('limits a class board to the class level', async () => {
      const ss2: any = await boards.board(ids.top, { scope: 'class', period: 'all', limit: 50 });
      expect(ss2.title).toBe('Lifetime XP · SS2 students');
      expect(ranksOf(ss2)).toEqual([[1, 5000], [2, 3000], [2, 3000], [4, 2000], [5, 100]]);
      const ss3: any = await boards.board(ids.top, { scope: 'class', period: 'all', classLevel: 'SS3' as any, limit: 50 });
      expect(ranksOf(ss3)).toEqual([[1, 2500]]);
    });

    it('serves the top from cache but always reads the viewer fresh', async () => {
      await (boards as any).cache.invalidate('lb:'); // earlier tests warmed this board
      const q = { scope: 'national' as const, period: 'all' as const, limit: 50 };
      const first = await boards.board(ids.lagosLow, q);
      expect(first.cached).toBe(false);
      await prisma.user.update({ where: { id: ids.lagosLow }, data: { xp: 4000 } }); // jumps to 2nd place
      const second: any = await boards.board(ids.lagosLow, q);
      expect(second.cached).toBe(true);
      try {
        expect(second.entries.find((e: any) => e.isMe)).toMatchObject({ rank: 7, score: 100 }); // the cached list is up to a minute old...
        expect(second.me).toMatchObject({ rank: 2, score: 4000 }); // ...but their own place is current
      } finally {
        await prisma.user.update({ where: { id: ids.lagosLow }, data: { xp: 100 } }); // never leave data changed for the next test
      }
    });

    it('keeps the original response shape for older clients', async () => {
      const legacy = await boards.legacy(ids.top, 'all', 3);
      expect(legacy.top.map((e) => [e.rank, e.xp, e.isMe])).toEqual([[1, 5000, true], [2, 3000, false], [2, 3000, false]]);
      expect(legacy.me).toMatchObject({ rank: 1, xp: 5000 });
    });
  });

  describe('XP this week and this month', () => {
    it('counts only the last 7 (or 30) days including today, and ignores older activity', async () => {
      const [a, b, c, e] = [await make(0, { state: 'Plateau', classLevel: 'JSS1' }), await make(0, { state: 'Plateau', classLevel: 'JSS1' }), await make(0, { state: 'Plateau', classLevel: 'JSS1' }), await make(0, { state: 'Plateau', classLevel: 'JSS1' })];
      await prisma.dailyActivity.createMany({
        data: [
          { userId: a, date: ago(0), xpEarned: 100 }, { userId: a, date: ago(6), xpEarned: 50 }, // both in the week: 150
          { userId: a, date: ago(7), xpEarned: 900 }, // 8th day back: not in the week, in the month
          { userId: b, date: ago(3), xpEarned: 120 },
          { userId: b, date: ago(29), xpEarned: 10 }, // the month's last day
          { userId: c, date: ago(30), xpEarned: 999 }, // just outside the month
          { userId: e, date: ago(1), xpEarned: 0 }, // no XP: not ranked
        ],
      });
      const week: any = await boards.board(a, { scope: 'state', state: 'Plateau', period: 'weekly', limit: 10 });
      expect(week.title).toBe('XP this week · Plateau');
      expect(ranksOf(week)).toEqual([[1, 150], [2, 120]]);
      expect(week.me).toMatchObject({ rank: 1, score: 150 });

      const month: any = await boards.board(a, { scope: 'state', state: 'Plateau', period: 'monthly', limit: 10 });
      expect(month.title).toBe('XP this month · Plateau');
      expect(ranksOf(month)).toEqual([[1, 1050], [2, 130]]);
      expect((await boards.board(c, { scope: 'state', state: 'Plateau', period: 'monthly', limit: 10 })).me).toBeNull();
      expect((await boards.board(e, { scope: 'state', state: 'Plateau', period: 'weekly', limit: 10 })).me).toBeNull();
    });

    it('ranks by what was earned in the window, not lifetime XP', async () => {
      const veteran = await make(90000, { state: 'Benue', classLevel: 'JSS2' });
      const newcomer = await make(200, { state: 'Benue', classLevel: 'JSS2' });
      await prisma.dailyActivity.createMany({ data: [{ userId: newcomer, date: ago(1), xpEarned: 200 }, { userId: veteran, date: ago(20), xpEarned: 500 }] });
      const week: any = await boards.board(veteran, { scope: 'state', state: 'Benue', period: 'weekly', limit: 10 });
      expect(ranksOf(week)).toEqual([[1, 200]]);
      expect(week.me).toBeNull(); // the veteran did nothing this week
    });
  });

  describe('subject boards', () => {
    it('ranks correct answers in one subject and only students with enough answers', async () => {
      const [ace, grinder, few, other] = [await make(0, { state: 'Edo' }), await make(0, { state: 'Edo' }), await make(0, { state: 'Edo' }), await make(0, { state: 'Edo' })];
      await prisma.subjectStat.createMany({
        data: [
          { userId: ace, subjectId, questionsAnswered: 100, correctAnswers: 90 },
          { userId: grinder, subjectId, questionsAnswered: 400, correctAnswers: 200 },
          { userId: few, subjectId, questionsAnswered: 19, correctAnswers: 19 }, // one short of the minimum
          { userId: other, subjectId: otherSubject, questionsAnswered: 100, correctAnswers: 100 }, // different subject
        ],
      });
      const b: any = await boards.board(ace, { scope: 'state', state: 'Edo', period: 'all', subjectId, limit: 10 });
      expect(b.title).toBe(`Correct answers in Maths ${tag} · Edo`);
      expect(b.minSubjectAnswers).toBe(20);
      expect(b.entries.map((e: any) => [e.rank, e.score, e.accuracy])).toEqual([[1, 200, 50], [2, 90, 90]]);
      expect(b.me).toMatchObject({ rank: 2, score: 90, accuracy: 90 });
      expect((await boards.board(few, { scope: 'state', state: 'Edo', period: 'all', subjectId, limit: 10 })).me).toBeNull();
    });

    it('ranks a rolling window of correct answers from attempt history', async () => {
      const [a, b, c] = [await make(0, { state: 'Enugu' }), await make(0, { state: 'Enugu' }), await make(0, { state: 'Enugu' })];
      const attempts = (userId: string, correct: number, wrong: number, when: Date) =>
        Array.from({ length: correct + wrong }, (_, i) => ({
          userId, questionId: `${tag}-q-${userId}-${when.getTime()}-${i}`, subjectId, correct: i < correct, source: 'QUIZ' as const, sourceRefId: `${userId}-${when.getTime()}`, createdAt: when,
        }));
      await prisma.questionAttempt.createMany({
        data: [
          ...attempts(a, 18, 7, new Date(Date.now() - 2 * day)), // 25 answers this week, 18 right
          ...attempts(b, 10, 20, new Date(Date.now() - 3 * day)), // 30 answers, 10 right
          ...attempts(c, 30, 0, new Date(Date.now() - 12 * day)), // all last fortnight: outside the week
        ],
      });
      const week: any = await boards.board(a, { scope: 'state', state: 'Enugu', period: 'weekly', subjectId, limit: 10 });
      expect(week.title).toBe(`Correct answers in Maths ${tag}, this week · Enugu`);
      expect(week.entries.map((e: any) => [e.rank, e.score, e.accuracy])).toEqual([[1, 18, 72], [2, 10, 33]]);
      const month: any = await boards.board(a, { scope: 'state', state: 'Enugu', period: 'monthly', subjectId, limit: 10 });
      expect(month.entries.map((e: any) => e.score)).toEqual([30, 18, 10]);
    });
  });

  describe('options', () => {
    it('lists the boards available to a student with a state', async () => {
      const u = await make(0, { state: 'Ekiti', classLevel: 'SS1', subjects: JSON.stringify([subjectId]) });
      const o = await boards.options(u);
      expect(o.scopes.map((s) => s.label)).toEqual(['Nigeria', 'Ekiti', 'South West', 'SS1 students']);
      expect(o.subjects.find((s) => s.id === subjectId)).toMatchObject({ mine: true });
      expect(o.subjects.find((s) => s.id === otherSubject)).toMatchObject({ mine: false });
    });
  });
});
