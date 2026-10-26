/**
 * Child safeguarding against a REAL Postgres: a parent or guardian's agreement
 * gates prize competitions for under-18s, registration records consent, a
 * student can export only their own data, and admins can withdraw consent and
 * erase an account. Skipped unless
 * TEST_DATABASE_URL points at a migrated, DISPOSABLE database (it deletes all
 * SS2 questions and every competition first).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminService } from '../src/modules/admin/admin.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { RefreshTokensService } from '../src/modules/auth/refresh-tokens.service';
import { POLICY_VERSION } from '../src/common/safeguarding';
import { SafeguardingService } from '../src/modules/users/safeguarding.service';
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

d('child safeguarding (real database)', () => {
  let prisma: PrismaService;
  let admin: AdminCompetitionsService;
  let results: AdminCompetitionResultsService;
  let comps: CompetitionsService;
  let sg: SafeguardingService;
  let adminSvc: AdminService;
  let auth: AuthService;
  let prizes: PrizesService;
  let certificates: CertificatesService;
  let quiz: QuizService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `sg${Date.now()}`;
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
    const sittings = new CompetitionSittingsService(prisma, ledger);
    const notifications = { notify } as any;
    const achievements = new AchievementsService(prisma, ledger, notifications);
    quiz = new QuizService(prisma, new ActivityService(prisma), ledger, new AttemptsService(prisma), { evaluate: async () => [] } as any, sittings);
    admin = new AdminCompetitionsService(prisma, audit);
    results = new AdminCompetitionResultsService(prisma, audit, quiz, notifications, achievements);
    comps = new CompetitionsService(prisma, notifications, sittings);
    sg = new SafeguardingService(prisma);
    adminSvc = new AdminService(prisma, audit);
    process.env.JWT_SECRET = 'test-secret';
    auth = new AuthService(prisma as any, new JwtService({}), {} as any, {} as any, new RefreshTokensService(prisma as any));
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

  const withPrizes = () => newCompetition(); // helper default has prizes
  const noPrizes = () => newCompetition({ prizes: [] });
  const gate = /parent or guardian needs to agree/i;

  describe('competitions with prizes', () => {
    let c: string;
    let free: string;
    beforeAll(async () => {
      c = await withPrizes();
      free = await noPrizes();
    });

    it('keeps a child out until a parent or guardian has agreed, and says why', async () => {
      const kid = await makeUser({ age: '16' });
      const row = (await comps.list(kid)).find((x) => x.id === c)!;
      expect(row).toMatchObject({ eligible: false, ineligibleReason: expect.stringMatching(gate) });
      await expect(comps.join(kid, c)).rejects.toThrow(gate);
      await expect(comps.start(kid, c)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await comps.detail(kid, c)).eligible).toBe(false);
    });

    it('does not ask for it on a competition without prizes', async () => {
      const kid = await makeUser({ age: '16' });
      expect((await comps.list(kid)).find((x) => x.id === free)!.eligible).toBe(true);
      await expect(comps.join(kid, free)).resolves.toEqual({ joined: true });
    });

    it('lets the child in once a parent or guardian is recorded, and shows only a masked number back', async () => {
      const kid = await makeUser({ age: '15' });
      await expect(sg.setGuardian(kid, { guardianName: 'Mrs Ade', guardianPhone: '12345' })).rejects.toBeInstanceOf(BadRequestException);
      const status = await sg.setGuardian(kid, { guardianName: 'Mrs Ade', guardianPhone: '0803 123 4567' });
      expect(status).toMatchObject({ isMinor: true, guardianConsentNeeded: false, guardian: { name: 'Mrs Ade', phone: '+234803***4567' } });
      expect(JSON.stringify(status)).not.toContain('8031234567');
      await expect(comps.join(kid, c)).resolves.toEqual({ joined: true });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: kid } })).guardianConsentVersion).toBe(POLICY_VERSION);
    });

    it('never asks an adult, and treats an unreadable age as a child', async () => {
      const adult = await makeUser({ age: '19' });
      await expect(comps.join(adult, c)).resolves.toEqual({ joined: true });
      const unknown = await makeUser({ age: null });
      await expect(comps.join(unknown, c)).rejects.toThrow(gate);
      const blank = await makeUser({ age: 'sixteen' });
      await expect(comps.join(blank, c)).rejects.toThrow(gate);
    });

    it('can be switched off', async () => {
      process.env.SAFEGUARDING_ENFORCED = 'false';
      try {
        const kid = await makeUser({ age: '12' });
        await expect(comps.join(kid, c)).resolves.toEqual({ joined: true });
      } finally {
        delete process.env.SAFEGUARDING_ENFORCED;
      }
    });
  });

  describe('policy acceptance and registration', () => {
    it('records the policy version, and refuses a stale one', async () => {
      const u = await makeUser();
      await expect(sg.acceptPolicy(u, 'old-version')).rejects.toThrow(/not the current policy version/);
      const s = await sg.acceptPolicy(u, POLICY_VERSION);
      expect(s.policy).toMatchObject({ accepted: true, acceptedVersion: POLICY_VERSION, currentVersion: POLICY_VERSION });
    });

    it('records acceptance and a guardian at sign-up when given, and refuses an incomplete or wrong one', async () => {
      const email = `${tag}-reg1@t.test`;
      await auth.register({ name: 'Reg One', email, password: 'passw0rd1', age: '15', acceptedPolicyVersion: POLICY_VERSION, guardianConsent: true, guardianName: 'Mr One', guardianPhone: '08031234567' });
      const u = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(u).toMatchObject({ policyAcceptedVersion: POLICY_VERSION, guardianName: 'Mr One', guardianPhone: '+2348031234567' });
      expect(u.guardianConsentAt).toBeInstanceOf(Date);

      const bad = (over: object) => auth.register({ name: 'Reg Two', email: `${tag}-reg2@t.test`, password: 'passw0rd1', ...over });
      await expect(bad({ guardianConsent: true, guardianName: 'Mr Two' })).rejects.toThrow(/name and a valid Nigerian phone/);
      await expect(bad({ acceptedPolicyVersion: 'stale' })).rejects.toThrow(/not the current policy version/);
      expect(await prisma.user.count({ where: { email: `${tag}-reg2@t.test` } })).toBe(0);

      const plain = `${tag}-reg3@t.test`;
      await auth.register({ name: 'Reg Three', email: plain, password: 'passw0rd1' }); // an older app that sends neither still registers
      expect((await prisma.user.findUniqueOrThrow({ where: { email: plain } })).guardianConsentAt).toBeNull();
    });
  });

  describe('a student seeing their own data', () => {
    it('exports their own information and nothing of anyone else, never the password or tokens', async () => {
      const me = await makeUser({ fullName: 'Mine Owner', passwordHash: 'argon2-secret-hash' });
      const other = await makeUser({ fullName: 'Someone Else', phone: '+2348099999999' });
      const c = await noPrizes();
      await comps.join(me, c);
      await comps.join(other, c);
      await prisma.certificate.create({ data: { userId: me, kind: 'PARTICIPATION', subjectName: 'Cup', title: 'Participant', verificationCode: `EQ-${tag.slice(-5).toUpperCase().replace(/[^A-Z2-9]/g, 'X')}-MINE2` } });
      const out = await sg.exportData(me);
      expect(out.profile).toMatchObject({ id: me, fullName: 'Mine Owner' });
      expect(out.competitions).toHaveLength(1);
      expect(out.certificates).toHaveLength(1);
      const json = JSON.stringify(out);
      expect(json).not.toMatch(/argon2-secret-hash|passwordHash|Someone Else|8099999999/);
      expect(json).not.toMatch(/refreshToken|tokenHash/);
    });
  });

  describe('admin actions for a parent or guardian', () => {
    it('can withdraw agreement, after which the child is blocked again, and records why', async () => {
      const c = await withPrizes();
      const kid = await makeUser({ age: '14' });
      await sg.setGuardian(kid, { guardianName: 'Mama Kid', guardianPhone: '08031234567' });
      await expect(adminSvc.withdrawGuardianConsent(adminId, kid, 'Parent phoned to withdraw')).resolves.toEqual({ withdrawn: true });
      await expect(comps.join(kid, c)).rejects.toThrow(gate);
      await expect(adminSvc.withdrawGuardianConsent(adminId, kid, 'again please')).rejects.toBeInstanceOf(NotFoundException);
      expect(await prisma.adminAuditLog.count({ where: { adminId, action: 'user.guardian_consent_withdrawn', entityId: kid } })).toBe(1);
    });

    it('can erase a student and everything they own, keeping only an audit line, but not an admin or itself', async () => {
      const kid = await makeUser({ age: '14' });
      const c = await noPrizes();
      await comps.join(kid, c);
      await sg.acceptPolicy(kid, POLICY_VERSION);
      await prisma.refreshToken.create({ data: { userId: kid, familyId: 'f', tokenHash: `h${kid}`, expiresAt: new Date(Date.now() + 1e9), familyExpiresAt: new Date(Date.now() + 1e9) } });
      await expect(adminSvc.eraseStudent(adminId, kid, 'Parent requested deletion')).resolves.toEqual({ erased: true });
      expect(await prisma.user.count({ where: { id: kid } })).toBe(0);
      expect(await prisma.competitionParticipant.count({ where: { userId: kid } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: kid } })).toBe(0);
      const line = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'user.erase', entityId: kid } });
      expect(line.summary).toContain('Parent requested deletion');
      expect(JSON.stringify(line)).not.toMatch(/Stu Dent/);
      await expect(adminSvc.eraseStudent(adminId, adminId, 'oops')).rejects.toThrow(/own account/);
      const other = await makeUser({ role: 'ADMIN' });
      await expect(adminSvc.eraseStudent(adminId, other, 'no')).rejects.toThrow(/Only student accounts/);
      await expect(adminSvc.eraseStudent(adminId, 'ghost', 'nobody')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
