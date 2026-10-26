/**
 * Competition results against a REAL Postgres: validation, finalising, prize
 * awards and claims, certificates and public verification. Skipped unless
 * TEST_DATABASE_URL points at a migrated, DISPOSABLE database (it deletes all
 * SS2 questions and every competition first).
 */
import { ConflictException } from '@nestjs/common';
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

d('competition results (real database)', () => {
  let prisma: PrismaService;
  let admin: AdminCompetitionsService;
  let results: AdminCompetitionResultsService;
  let comps: CompetitionsService;
  let prizes: PrizesService;
  let certificates: CertificatesService;
  let quiz: QuizService;
  const notify = jest.fn().mockResolvedValue(undefined);
  const tag = `rs${Date.now()}`;
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

  describe('finalising', () => {
    let c: string;
    let [a, b, cc, dd, ee, abandoned, didNotSit, cheat1, cheat2]: string[] = [];

    beforeAll(async () => {
      c = await newCompetition();
      [a, b, cc, dd, ee, abandoned, didNotSit, cheat1, cheat2] = await Promise.all(Array.from({ length: 9 }, () => makeUser()));
      await sit(c, a, { wrong: 0, secondsAgo: 90 }); // 5/5 fast
      await sit(c, b, { wrong: 0, secondsAgo: 200 }); // 5/5 slow
      await sit(c, cc, { wrong: 1, secondsAgo: 100 }); // 4/5
      await sit(c, dd, { wrong: 2, secondsAgo: 50 }); // 3/5, faster than the abandoned sitting below
      await sit(c, ee, { wrong: 3, secondsAgo: 100 }); // 2/5, a different sheet from the two copies below
      await sit(c, cheat1, { wrong: 4, secondsAgo: 80 }); // identical sheets, 4 wrong
      await sit(c, cheat2, { wrong: 4, secondsAgo: 85 });
      await sit(c, abandoned, { leaveOpen: true, lockOnly: 3, secondsAgo: 100 }); // locked 3 answers, never submitted
      await comps.join(didNotSit, c); // entered, never sat
      await close(c);
    });

    it('refuses to finalise before it closes, and validates only a closed competition', async () => {
      const open = await newCompetition();
      await expect(results.finalise(adminId, open)).rejects.toThrow(/after it closes/);
      await expect(results.validate(adminId, open)).rejects.toThrow(/closed competition/);
    });

    it('validation grades the abandoned sitting from its locked answers and flags identical sheets', async () => {
      const v = await results.validate(adminId, c);
      expect(v.settledSittings).toBe(1);
      expect(v.newlyFlagged).toBe(2);

      const entries = await results.entries(c);
      const mine = (u: string) => entries.find((e) => e.userId === u)!;
      expect(mine(abandoned)).toMatchObject({ status: 'COMPLETED', correctCount: 3, score: 3 }); // only what was locked
      expect(mine(cheat1).flags).toContain('SAME_ANSWERS');
      expect(mine(cheat2).flags).toContain('SAME_ANSWERS');
      expect(mine(cheat1).identicalSheets).toBe(1);
      expect(mine(a).flags).toEqual([]);
      expect(mine(didNotSit)).toMatchObject({ status: 'ENTERED', score: null, position: null });
      // Identical *perfect* sheets are normal and must not be flagged.
      expect(mine(b).flags).toEqual([]);
      expect(v.needsReview.map((e) => e.userId).sort()).toEqual([cheat1, cheat2].sort());
      // Running it again changes nothing.
      expect((await results.validate(adminId, c)).newlyFlagged).toBe(0);
    });

    it('an admin can disqualify and reinstate before results are final', async () => {
      await results.disqualify(adminId, c, cheat2, 'Copied the answer sheet of another entrant');
      expect((await results.entries(c)).find((e) => e.userId === cheat2)).toMatchObject({ status: 'DISQUALIFIED', disqualifiedReason: expect.stringMatching(/Copied/) });
      expect((await comps.leaderboard(a, c) as any).top.some((e: any) => e.isMe === false && e.score === 1)).toBe(true); // cheat1 still ranked
      await results.reinstate(adminId, c, cheat2);
      expect((await results.entries(c)).find((e) => e.userId === cheat2)!.status).toBe('COMPLETED');
      await results.disqualify(adminId, c, cheat2, 'Copied the answer sheet of another entrant');
    });

    it('finalises once: fixes ranks, creates prize awards and issues certificates', async () => {
      const outcomes = await Promise.allSettled([results.finalise(adminId, c), results.finalise(adminId, c), results.finalise(adminId, c)]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected').every((o: any) => o.reason instanceof ConflictException)).toBe(true);
      const comp = await prisma.competition.findUniqueOrThrow({ where: { id: c } });
      expect(comp.status).toBe('FINALISED');
      expect(comp.finalisedAt).not.toBeNull();

      const entries = await prisma.competitionParticipant.findMany({ where: { competitionId: c } });
      const rankOf = (u: string) => entries.find((e) => e.userId === u)!.rank;
      expect([a, b, cc, dd, abandoned, ee, cheat1].map(rankOf)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('ranks by score, then faster time; excludes the disqualified and those who never sat', async () => {
      const entries = await prisma.competitionParticipant.findMany({ where: { competitionId: c }, orderBy: { rank: 'asc' } });
      const ranked = entries.filter((e) => e.rank !== null);
      expect(ranked.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(ranked.map((e) => e.score)).toEqual([5, 5, 4, 3, 3, 2, 1]); // equal scores ordered by time
      const byUser = new Map(entries.map((e) => [e.userId, e]));
      expect(byUser.get(cheat2)).toMatchObject({ rank: null, status: 'DISQUALIFIED' });
      expect(byUser.get(didNotSit)).toMatchObject({ rank: null, status: 'ENTERED' });
    });

    it('creates a prize award for each prized position and nobody else', async () => {
      const awards = await prisma.prizeAward.findMany({ where: { competitionId: c }, include: { prize: true }, orderBy: { rank: 'asc' } });
      expect(awards.map((x) => [x.rank, x.prize.title, x.status, x.userId])).toEqual([
        [1, '500 coins', 'AWAITING_CLAIM', a],
        [2, '1GB data', 'AWAITING_CLAIM', b],
        [3, '1GB data', 'AWAITING_CLAIM', cc],
        [4, 'Tablet', 'AWAITING_CLAIM', dd],
      ]);
      const week = 7 * day;
      for (const x of awards) expect(Math.abs(x.claimDeadline.getTime() - (Date.now() + week))).toBeLessThan(60_000);
    });

    it('issues participation certificates to finishers and winner certificates to the podium, each with a unique code', async () => {
      const certs = await prisma.certificate.findMany({ where: { competitionId: c } });
      const kinds = (u: string) => certs.filter((x) => x.userId === u).map((x) => x.kind).sort();
      expect(kinds(a)).toEqual(['PARTICIPATION', 'WINNER']);
      expect(kinds(cc)).toEqual(['PARTICIPATION', 'WINNER']);
      expect(kinds(dd)).toEqual(['PARTICIPATION']); // 4th: a prize, but no winner certificate
      expect(kinds(abandoned)).toEqual(['PARTICIPATION']);
      expect(kinds(cheat2)).toEqual([]); // disqualified
      expect(kinds(didNotSit)).toEqual([]);
      expect(new Set(certs.map((x) => x.verificationCode)).size).toBe(certs.length);
      expect(certs.find((x) => x.userId === a && x.kind === 'WINNER')).toMatchObject({ rank: 1, title: 'Winner' });
      expect(certs.find((x) => x.userId === b && x.kind === 'WINNER')).toMatchObject({ rank: 2, title: 'Runner-up' });
      expect(certs.find((x) => x.userId === cc && x.kind === 'WINNER')).toMatchObject({ rank: 3, title: 'Third place' });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a } })).certificates).toBe(2);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: dd } })).certificates).toBe(1);
    });

    it('unlocks Top Finisher for the podium only', async () => {
      const has = async (u: string, key: string) => (await prisma.userAchievement.count({ where: { userId: u, key } })) === 1;
      expect(await has(a, 'top_finisher')).toBe(true);
      expect(await has(cc, 'top_finisher')).toBe(true);
      expect(await has(dd, 'top_finisher')).toBe(false);
      expect(await has(dd, 'first_competition')).toBe(true);
    });

    it('tells winners and finishers, and locks the entries after finalising', async () => {
      const sent = notify.mock.calls.filter((x) => x[4]?.competitionId === c);
      expect(sent.find((x) => x[0] === a)![1]).toBe('prize_won');
      expect(sent.find((x) => x[0] === ee)![1]).toBe('competition_results');
      await expect(results.disqualify(adminId, c, a, 'too late for this')).rejects.toBeInstanceOf(ConflictException);
      await expect(results.finalise(adminId, c)).rejects.toThrow(/already finalised/);
    });

    it('publishes the final board and gives each student their history', async () => {
      const board: any = await comps.leaderboard(a, c);
      expect(board).toMatchObject({ final: true, completed: 7 });
      expect(board.top.map((e: any) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const hist = await comps.history(a);
      expect(hist[0]).toMatchObject({ rank: 1, score: 5, outOf: 7, lifecycle: 'FINALISED', prize: { title: '500 coins', status: 'AWAITING_CLAIM' } });
      expect(hist[0].certificates.map((x: any) => x.kind).sort()).toEqual(['PARTICIPATION', 'WINNER']);
      const disq = (await comps.history(cheat2))[0];
      expect(disq).toMatchObject({ status: 'DISQUALIFIED', rank: null, prize: null });
      expect(disq.disqualifiedReason).toMatch(/Copied/);
      expect(await comps.review(a, c).then((r) => r.items.length)).toBe(5);
    });

    it('lets anyone verify a certificate by code, showing only a first name and initial', async () => {
      const winner = await prisma.certificate.findFirstOrThrow({ where: { userId: a, competitionId: c, kind: 'WINNER' } });
      const ok: any = await certificates.verify(winner.verificationCode.toLowerCase());
      expect(ok).toMatchObject({ valid: true, kind: 'WINNER', rank: 1, holder: 'Stu D.' });
      expect(ok.competition.title).toContain(tag);
      expect(JSON.stringify(ok)).not.toMatch(/@t\.test/);
      expect(await certificates.verify('EQ-ZZZZZ-ZZZZZ')).toEqual({ valid: false });
    });

    it('archives a finalised competition', async () => {
      await expect(results.archive(adminId, c)).resolves.toEqual({ status: 'ARCHIVED' });
      await expect(results.archive(adminId, c)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('prize claims and delivery', () => {
    let c: string;
    let [w1, w2, w3, w4, w5, w6]: string[] = [];
    let award: Record<string, string> = {};

    beforeAll(async () => {
      c = await newCompetition();
      [w1, w2, w3, w4, w5, w6] = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
      // distinct scores and times so ranks are 1..6 in this order
      await sit(c, w1, { wrong: 0, secondsAgo: 100 });
      await sit(c, w2, { wrong: 1, secondsAgo: 100 });
      await sit(c, w3, { wrong: 2, secondsAgo: 100 });
      await sit(c, w4, { wrong: 3, secondsAgo: 100 });
      await sit(c, w5, { wrong: 4, secondsAgo: 100 });
      await sit(c, w6, { wrong: 5, secondsAgo: 100 });
      await close(c);
      await results.finalise(adminId, c);
      const rows = await prisma.prizeAward.findMany({ where: { competitionId: c } });
      award = Object.fromEntries(rows.map((r) => [r.userId, r.id]));
    });

    it('shows a winner what they won and what the claim needs', async () => {
      const mine = await prizes.mine(w2);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ rank: 2, status: 'AWAITING_CLAIM', canClaim: true, prize: { title: '1GB data', kind: 'DATA' }, requires: { contactPhone: true, guardianPhone: false } });
      expect(await prizes.mine(w6)).toEqual([]);
    });

    it('pays a coin prize exactly once, only after it is verified', async () => {
      await expect(prizes.fulfil(adminId, award[w1])).rejects.toThrow(/Only a verified prize/);
      await prizes.verify(adminId, award[w1]); // coin prizes need no claim first
      const results2 = await Promise.allSettled([prizes.fulfil(adminId, award[w1]), prizes.fulfil(adminId, award[w1]), prizes.fulfil(adminId, award[w1])]);
      expect(results2.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const prizeRows = await prisma.ledgerEntry.findMany({ where: { userId: w1, reason: 'competition_prize' } });
      expect(prizeRows.map((r) => [r.currency, r.amount])).toEqual([['COIN', 500]]); // once, not three times
      const sums = await ledgerSums(w1); // achievements add rewards of their own; the books must still balance
      expect(sums.coins).toBe(sums.ledgerCoins);
      expect(sums.xp).toBe(sums.ledgerXp);
      expect((await prizes.mine(w1))[0].status).toBe('FULFILLED');
    });

    it('needs the winner to claim a data prize before it can be verified and fulfilled', async () => {
      await expect(prizes.verify(adminId, award[w2])).rejects.toThrow(/has to claim/);
      await expect(prizes.claim(w3, award[w2], { contactPhone: '08031234567' })).rejects.toThrow(/not found/i); // not theirs
      await expect(prizes.claim(w2, award[w2], { contactPhone: 'nope' })).rejects.toThrow(/valid Nigerian phone/);
      await prizes.claim(w2, award[w2], { contactPhone: '0803 123 4567' });
      await expect(prizes.claim(w2, award[w2], { contactPhone: '08031234567' })).rejects.toThrow(/already claimed/);

      const row = (await prizes.adminList({ competitionId: c })).find((x) => x.id === award[w2])!;
      expect(row).toMatchObject({ status: 'CLAIMED', claimDetails: { contactPhone: '+2348031234567' }, winner: { id: w2 } });

      await prizes.verify(adminId, award[w2]);
      const done = await prizes.fulfil(adminId, award[w2], 'Sent 1GB via MTN');
      expect(done).toEqual({ status: 'FULFILLED', coinsPaid: 0 });
      expect(await prisma.ledgerEntry.count({ where: { userId: w2, reason: 'competition_prize' } })).toBe(0); // a data prize pays no coins
    });

    it('lets an overdue unclaimed prize be forfeited and passes it to the next finisher without a prize', async () => {
      await prisma.prizeAward.update({ where: { id: award[w3] }, data: { claimDeadline: new Date(Date.now() - day) } });
      await expect(prizes.claim(w3, award[w3], { contactPhone: '08031234567' })).rejects.toThrow(/claim period/);
      const overdue = await prizes.adminList({ competitionId: c, overdue: true });
      expect(overdue.map((x) => x.id)).toEqual([award[w3]]);

      const out = await prizes.forfeit(adminId, award[w3], 'Not claimed within 7 days');
      // Prizes were for ranks 1, 2-3, 4: ranks 5 inherits the vacated one (the deepest award was rank 4).
      expect(out.status).toBe('FORFEITED');
      expect(out.promotedTo).toMatchObject({ userId: w5, rank: 5 });
      const promoted = await prisma.prizeAward.findUniqueOrThrow({ where: { id: out.promotedTo!.awardId }, include: { prize: true } });
      expect(promoted).toMatchObject({ status: 'AWAITING_CLAIM', promotedFromId: award[w3] });
      expect(promoted.prize.title).toBe('1GB data');
      expect(promoted.claimDeadline.getTime()).toBeGreaterThan(Date.now() + 6 * day);
      await expect(prizes.forfeit(adminId, award[w3], 'again')).rejects.toThrow(/already closed/);
    });

    it('rejects a failed verification and passes it on, never to someone who already has a prize', async () => {
      await prizes.claim(w4, award[w4], { contactPhone: '08031234567', guardianPhone: '08051234567', note: '12 Ikoyi Road' });
      const out = await prizes.reject(adminId, award[w4], 'Identity could not be confirmed');
      expect(out.status).toBe('REJECTED');
      expect(out.promotedTo).toMatchObject({ userId: w6, rank: 6 }); // w5 already holds the inherited prize
      const again = await prizes.reject(adminId, out.promotedTo!.awardId, 'No one is left', true);
      expect(again.promotedTo).toBeNull(); // nobody ranked below remains
    });

    it('records the whole story in notifications', async () => {
      const types = notify.mock.calls.filter((x) => x[0] === w3 || x[0] === w4).map((x) => x[1]);
      expect(types).toEqual(expect.arrayContaining(['prize_won', 'prize_forfeited', 'prize_rejected']));
    });
  });

  describe('older XP-window competitions', () => {
    it('have no sittings to validate', async () => {
      const legacy = await prisma.competition.create({
        data: { title: `${tag} legacy`, subtitle: 's', prizes: [], startsAt: new Date(Date.now() - 9 * day), endsAt: new Date(Date.now() - day), format: 'XP_WINDOW', status: 'CLOSED' },
      });
      await expect(results.validate(adminId, legacy.id)).rejects.toThrow(/ranked by XP/);
      await expect(results.finalise(adminId, legacy.id)).rejects.toThrow(/ranked by XP/);
    });
  });
});
