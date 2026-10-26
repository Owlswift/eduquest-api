/**
 * Sponsors against a REAL Postgres: logo checks, the sponsor shown on
 * competitions to students (logo only), and removal rules. Skipped unless
 * TEST_DATABASE_URL points at a migrated, DISPOSABLE database (it deletes all
 * SS2 questions and every competition first).
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SponsorsService } from '../src/modules/sponsors/sponsors.service';
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

d('sponsors (real database)', () => {
  let prisma: PrismaService;
  let admin: AdminCompetitionsService;
  let results: AdminCompetitionResultsService;
  let comps: CompetitionsService;
  let sponsors: SponsorsService;
  let prizes: PrizesService;
  let certificates: CertificatesService;
  let quiz: QuizService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `sp${Date.now()}`;
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
    sponsors = new SponsorsService(prisma, audit);
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
    await prisma.sponsor.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.adminAuditLog.deleteMany({ where: { adminId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.question.deleteMany({ where: { classLevel: 'SS2' } });
    await prisma.subject.delete({ where: { id: subjectId } });
    await prisma.$disconnect();
  });

  const png = (extra = 40) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);
  const draft = (over: Record<string, unknown> = {}) =>
    admin.create(adminId, {
      title: `${tag} cup ${++n}`, subtitle: 's', type: 'MONTHLY', questionCount: 5, subjectIds: [subjectId], classLevels: ['SS2'],
      startsAt: new Date(Date.now() + day).toISOString(), endsAt: new Date(Date.now() + 8 * day).toISOString(),
      prizes: [{ positionFrom: 1, positionTo: 1, title: 'Laptop', kind: 'DEVICE' }], ...over,
    } as any);

  describe('adding sponsors', () => {
    it('stores a PNG logo and lists the sponsor without its bytes', async () => {
      const s = await sponsors.create(adminId, { name: `${tag} Acme`, websiteUrl: 'https://acme.test' }, png());
      expect(s).toMatchObject({ name: `${tag} Acme`, websiteUrl: 'https://acme.test', competitions: 0 });
      expect(s.logoUrl).toMatch(/^\/api\/sponsors\/.+\/logo\?v=\d+$/);
      const listed = (await sponsors.list()).find((x) => x.id === s.id)!;
      expect(JSON.stringify(listed)).not.toContain('logoData');
      const logo = await sponsors.logo(s.id);
      expect(logo.type).toBe('image/png');
      expect(logo.data.equals(png())).toBe(true);
    });

    it('refuses a missing name or logo, non-images (including SVG with script), oversize files and duplicate names', async () => {
      await expect(sponsors.create(adminId, { name: '' }, png())).rejects.toThrow(/needs a name/);
      await expect(sponsors.create(adminId, { name: `${tag} NoLogo` }, undefined)).rejects.toThrow(/needs a logo/);
      await expect(sponsors.create(adminId, { name: `${tag} Svg` }, Buffer.from('<svg><script>alert(1)</script></svg>'))).rejects.toThrow(/PNG, JPEG or WebP/);
      await expect(sponsors.create(adminId, { name: `${tag} Big` }, png(400 * 1024))).rejects.toThrow(/too large/);
      await sponsors.create(adminId, { name: `${tag} Twin` }, png());
      await expect(sponsors.create(adminId, { name: `${tag} Twin` }, png())).rejects.toBeInstanceOf(ConflictException);
    });

    it('replaces a logo (new version in the url) and edits the name without touching it', async () => {
      const s = await sponsors.create(adminId, { name: `${tag} Swap` }, png(10));
      await new Promise((r) => setTimeout(r, 15));
      const renamed = await sponsors.update(adminId, s.id, { name: `${tag} Swapped` }, undefined);
      expect(renamed.logoUrl).toBe(s.logoUrl);
      expect((await sponsors.logo(s.id)).data.length).toBe(png(10).length);
      const swapped = await sponsors.update(adminId, s.id, {}, png(30));
      expect(swapped.logoUrl).not.toBe(s.logoUrl);
      expect((await sponsors.logo(s.id)).data.length).toBe(png(30).length);
      await expect(sponsors.update(adminId, s.id, {}, Buffer.from('nope'))).rejects.toBeInstanceOf(BadRequestException);
      await expect(sponsors.logo('ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('on competitions', () => {
    let sponsorId: string;
    beforeAll(async () => {
      sponsorId = (await sponsors.create(adminId, { name: `${tag} Shown`, websiteUrl: 'https://shown.test' }, png())).id;
    });

    it('shows students the logo, name and link, and nothing else about the sponsor', async () => {
      const c = await draft({ sponsorId });
      expect(c.sponsor).toMatchObject({ id: sponsorId, name: `${tag} Shown`, websiteUrl: 'https://shown.test' });
      await admin.publish(adminId, c.id);
      const u = await makeUser();
      const listed = (await comps.list(u)).find((x) => x.id === c.id)!;
      expect(Object.keys(listed.sponsor!).sort()).toEqual(['id', 'logoUrl', 'name', 'websiteUrl']);
      expect(listed.sponsor!.logoUrl).toContain(`/sponsors/${sponsorId}/logo`);
      expect((await comps.detail(u, c.id)).sponsor).toEqual(listed.sponsor);
      const none = await draft();
      expect(none.sponsor).toBeNull();
    });

    it('rejects an unknown sponsor, and can add, change and remove one while editable', async () => {
      await expect(draft({ sponsorId: 'ghost' })).rejects.toThrow(/does not exist/);
      const c = await draft();
      expect((await admin.update(adminId, c.id, { sponsorId })).sponsor!.id).toBe(sponsorId);
      expect((await admin.update(adminId, c.id, { sponsorId: null })).sponsor).toBeNull();
    });

    it('can be set after publishing (branding does not change the rules) but not once it is running', async () => {
      const c = await draft();
      await admin.publish(adminId, c.id);
      expect((await admin.update(adminId, c.id, { sponsorId })).sponsor!.id).toBe(sponsorId);
      await prisma.competition.update({ where: { id: c.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
      await expect(admin.update(adminId, c.id, { sponsorId: null })).rejects.toBeInstanceOf(ConflictException);
    });

    it('cannot be deleted while a competition still shows it, but can be once none does', async () => {
      const s = await sponsors.create(adminId, { name: `${tag} Busy` }, png());
      const c = await draft({ sponsorId: s.id });
      await expect(sponsors.remove(adminId, s.id)).rejects.toThrow(/1 competition still shows this sponsor/);
      await admin.update(adminId, c.id, { sponsorId: null });
      await expect(sponsors.remove(adminId, s.id)).resolves.toEqual({ deleted: true });
      await expect(sponsors.logo(s.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
