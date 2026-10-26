/**
 * Competition stages against a REAL Postgres: a qualifier's top finishers
 * (completed, not disqualified) are qualified for a final that nobody else can
 * enter. Skipped unless
 * TEST_DATABASE_URL points at a migrated, DISPOSABLE database (it deletes all
 * SS2 questions and every competition first).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

d('competition stages (real database)', () => {
  let prisma: PrismaService;
  let admin: AdminCompetitionsService;
  let results: AdminCompetitionResultsService;
  let comps: CompetitionsService;
  let prizes: PrizesService;
  let certificates: CertificatesService;
  let quiz: QuizService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `st${Date.now()}`;
  const subjectId = `${tag}-subj`;
  const userIds: string[] = [];
  let adminId: string;
  let n = 0;
  const day = 86_400_000;

  const makeUser = async (over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `Stu Dent${n}`, username: id, email: `${id}@t.test`, classLevel: 'SS2', state: 'Lagos', ...over } });
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
    const sittings = new CompetitionSittingsService(prisma, ledger);
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

  const finalDraft = (over: Record<string, unknown> = {}) =>
    admin.create(adminId, {
      title: `${tag} final`, subtitle: 'f', type: 'NATIONAL', questionCount: 5, subjectIds: [subjectId], classLevels: ['SS2'],
      requiresQualification: true,
      startsAt: new Date(Date.now() + 10 * day).toISOString(), endsAt: new Date(Date.now() + 15 * day).toISOString(),
      prizes: [{ positionFrom: 1, positionTo: 1, title: 'Laptop', kind: 'DEVICE' }],
      ...over,
    } as any);
  const qualifier = (over: Record<string, unknown>) => newCompetition(over);

  describe('linking stages', () => {
    it('rejects a link that cannot work, and says why', async () => {
      const plain = await finalDraft({ requiresQualification: false, title: `${tag} plain` });
      await expect(qualifier({ nextStageId: plain.id, advanceCount: 2 })).rejects.toThrow(/by qualification/);
      const final = await finalDraft();
      await expect(qualifier({ nextStageId: final.id })).rejects.toThrow(/how many/i);
      await expect(qualifier({ nextStageId: 'ghost', advanceCount: 2 })).rejects.toBeInstanceOf(BadRequestException);
      const early = await finalDraft({ title: `${tag} early`, startsAt: new Date(Date.now() + 2 * day).toISOString(), endsAt: new Date(Date.now() + 3 * day).toISOString() });
      await expect(qualifier({ nextStageId: early.id, advanceCount: 2 })).rejects.toThrow(/start after/);
    });

    it('refuses a self link and a loop', async () => {
      const f = await finalDraft({ title: `${tag} loopA` });
      await expect(admin.update(adminId, f.id, { nextStageId: f.id, advanceCount: 3 })).rejects.toThrow(/itself/);
      const g = await finalDraft({ title: `${tag} loopB`, startsAt: new Date(Date.now() + 20 * day).toISOString(), endsAt: new Date(Date.now() + 22 * day).toISOString(), nextStageId: undefined });
      await admin.update(adminId, f.id, { nextStageId: g.id, advanceCount: 3 });
      await expect(admin.update(adminId, g.id, { nextStageId: f.id, advanceCount: 3 })).rejects.toThrow(/loop|start after/);
    });

    it('stops a final starting before the qualifier that feeds it ends', async () => {
      const final = await finalDraft({ title: `${tag} feeds` });
      const q = await qualifier({ nextStageId: final.id, advanceCount: 2 });
      await expect(admin.update(adminId, final.id, { startsAt: new Date(Date.now() + 2 * day).toISOString(), endsAt: new Date(Date.now() + 12 * day).toISOString() })).rejects.toThrow(/feeds this competition/);
      expect(q).toBeTruthy();
    });
  });

  describe('a qualifier into a final', () => {
    let q: string;
    let finalId: string;
    let [first, second, third, fourth, cheat, nobody]: string[] = [];

    beforeAll(async () => {
      const final = await finalDraft({ title: `${tag} national final` });
      finalId = final.id;
      q = await qualifier({ nextStageId: finalId, advanceCount: 2 });
      [first, second, third, fourth, cheat, nobody] = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
      await sit(q, cheat, { wrong: 0, secondsAgo: 30 }); // would be 1st, but is disqualified below
      await sit(q, first, { wrong: 0, secondsAgo: 90 });
      await sit(q, second, { wrong: 1, secondsAgo: 90 });
      await sit(q, third, { wrong: 2, secondsAgo: 90 });
      await sit(q, fourth, { wrong: 3, secondsAgo: 90 });
      await comps.join(nobody, q); // entered but never sat
      await close(q);
      await results.validate(adminId, q);
      await results.disqualify(adminId, q, cheat, 'Copied another entrant');
    });

    it('qualifies exactly the top finishers who are not disqualified, and reports how many', async () => {
      const done = await results.finalise(adminId, q);
      expect(done).toMatchObject({ status: 'FINALISED', qualified: 2 });
      const rows = await admin.qualifiers(finalId);
      expect(rows.map((r) => [r.userId, r.fromRank])).toEqual([[first, 1], [second, 2]]);
      expect(rows[0].fromCompetition.title).toContain(tag);
      expect((await admin.get(finalId)).qualified).toBe(2);
    });

    it('lets the qualified enter and sit the final, and nobody else', async () => {
      await admin.publish(adminId, finalId);
      await prisma.competition.update({ where: { id: finalId }, data: { startsAt: new Date(Date.now() - 60_000) } });

      await expect(comps.join(third, finalId)).rejects.toThrow(/qualification/i);
      await expect(comps.start(fourth, finalId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(comps.start(cheat, finalId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(comps.start(nobody, finalId)).rejects.toBeInstanceOf(ForbiddenException);

      await expect(comps.join(first, finalId)).resolves.toEqual({ joined: true });
      const started = await comps.start(second, finalId);
      expect(started.questions).toHaveLength(5);
    });

    it('shows each student whether they are in, and why not if they are out', async () => {
      const mineIn = (await comps.list(first)).find((c) => c.id === finalId)!;
      expect(mineIn).toMatchObject({ requiresQualification: true, eligible: true, qualification: { fromRank: 1 } });
      expect(mineIn.qualification!.fromCompetition).toContain(tag);
      const mineOut = (await comps.list(third)).find((c) => c.id === finalId)!;
      expect(mineOut).toMatchObject({ eligible: false, qualification: null, ineligibleReason: expect.stringMatching(/qualification/i) });
      expect(await comps.detail(first, finalId)).toMatchObject({ eligible: true, qualification: { fromRank: 1 } });
    });

    it('tells the qualifiers, once', async () => {
      const calls = notify.mock.calls.filter((c) => c[1] === 'competition_qualified');
      expect(calls.map((c) => c[0]).sort()).toEqual([first, second].sort());
      expect(calls[0][5]).toEqual({ dedupeKey: expect.stringContaining(`qualified:${finalId}:`) });
    });
  });

  describe('edge cases', () => {
    it('qualifies fewer than the places when fewer finished, and keeps a student qualified earlier', async () => {
      const final = await finalDraft({ title: `${tag} shared final` });
      const q1 = await qualifier({ nextStageId: final.id, advanceCount: 5 });
      const q2 = await qualifier({ nextStageId: final.id, advanceCount: 5 });
      const [x, y] = await Promise.all([makeUser(), makeUser()]);
      await sit(q1, x, { wrong: 0, secondsAgo: 60 });
      await sit(q2, x, { wrong: 0, secondsAgo: 60 });
      await sit(q2, y, { wrong: 1, secondsAgo: 60 });
      await close(q1);
      await close(q2);
      expect((await results.finalise(adminId, q1)).qualified).toBe(1);
      expect((await results.finalise(adminId, q2)).qualified).toBe(2); // x already in: skipped by the unique key, y added
      const rows = await admin.qualifiers(final.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.userId === x)!.fromCompetition.id).toBe(q1);
    });

    it('finalises normally, qualifying nobody, when the final has already closed', async () => {
      const final = await finalDraft({ title: `${tag} too late` });
      const q1 = await qualifier({ nextStageId: final.id, advanceCount: 3 });
      const z = await makeUser();
      await sit(q1, z, { wrong: 0, secondsAgo: 60 });
      await close(q1);
      await prisma.competition.update({ where: { id: final.id }, data: { status: 'CLOSED', startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - day) } });
      expect(await results.finalise(adminId, q1)).toMatchObject({ status: 'FINALISED', qualified: 0 });
      expect(await prisma.competitionQualification.count({ where: { competitionId: final.id } })).toBe(0);
    });

    it('does nothing extra for a competition with no next stage', async () => {
      const plain = await newCompetition();
      const w = await makeUser();
      await sit(plain, w, { wrong: 0, secondsAgo: 60 });
      await close(plain);
      expect((await results.finalise(adminId, plain)).qualified).toBe(0);
    });
  });
});
