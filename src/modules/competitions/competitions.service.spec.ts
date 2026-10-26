import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CompetitionsService } from './competitions.service';

describe('CompetitionsService', () => {
  let prisma: any;
  let notifications: { notify: jest.Mock };
  let service: CompetitionsService;
  const day = 86_400_000;

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'c1', title: 'June', subtitle: 's', description: null, prizes: [], type: 'MONTHLY', format: 'FIXED_SET', status: 'ACTIVE',
    startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day), classLevels: [], subjectIds: ['math'], state: null,
    region: null, questionCount: 3, questionIds: ['q1', 'q2', 'q3'], pointsPerCorrect: 1, penaltyPerWrong: 0, timeLimitSec: 600,
    participationXp: 0, participationCoins: 0, claimDeadlineDays: 14, prizeList: [], _count: { participants: 4 }, ...over,
  });

  beforeEach(() => {
    prisma = {
      competition: { findMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      competitionQualification: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
      competitionParticipant: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), createMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ classLevel: 'SS2', state: 'Lagos' }), findUnique: jest.fn().mockResolvedValue({ xp: 40 }) },
      quizSession: { findUnique: jest.fn(), create: jest.fn(), findUniqueOrThrow: jest.fn() },
      question: { findMany: jest.fn().mockResolvedValue([]) },
      questionAttempt: { findMany: jest.fn() },
    };
    notifications = { notify: jest.fn() };
    service = new CompetitionsService(prisma, notifications as any, {} as any);
  });

  describe('list', () => {
    it('hides drafts, follows the clock, and keeps the fields older clients read', async () => {
      prisma.competition.findMany.mockResolvedValue([
        row({ id: 'soon', status: 'PUBLISHED', startsAt: new Date(Date.now() + day), endsAt: new Date(Date.now() + 3 * day), prizeList: [{ title: 'Tablet' }] }),
        row({ id: 'over', status: 'ACTIVE', startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - day) }),
      ]);
      prisma.competitionParticipant.findMany.mockResolvedValue([{ competitionId: 'soon', status: 'ENTERED', score: null, rank: null }]);

      const out = await service.list('u1');

      expect(prisma.competition.findMany.mock.calls[0][0].where).toEqual({ status: { not: 'DRAFT' } });
      expect(out[0]).toMatchObject({ id: 'soon', status: 'upcoming', lifecycle: 'PUBLISHED', isJoined: true, participantCount: 4, prizes: ['Tablet'] });
      expect(out[1]).toMatchObject({ id: 'over', status: 'ended', lifecycle: 'CLOSED', isJoined: false });
      expect(prisma.competition.updateMany).toHaveBeenCalledWith({ where: { id: 'over', status: 'ACTIVE' }, data: { status: 'CLOSED' } });
    });

    it('says whether the student can enter, and why not', async () => {
      prisma.competition.findMany.mockResolvedValue([row({ classLevels: ['SS3'] }), row({ id: 'lag', type: 'STATE', state: 'Kano' })]);
      const [a, b] = await service.list('u1');
      expect(a).toMatchObject({ eligible: false });
      expect(a.ineligibleReason).toMatch(/SS3.*SS2/);
      expect(b.ineligibleReason).toMatch(/Kano/);
    });
  });

  describe('join', () => {
    beforeEach(() => {
      prisma.competition.findFirst.mockResolvedValue(row());
      prisma.competitionParticipant.findUnique.mockResolvedValue(null);
    });

    it('enters an eligible student and notifies once', async () => {
      await service.join('u1', 'c1');
      expect(prisma.competitionParticipant.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
      expect(notifications.notify).toHaveBeenCalledTimes(1);

      prisma.competitionParticipant.findUnique.mockResolvedValue({ id: 'p' });
      await service.join('u1', 'c1');
      expect(notifications.notify).toHaveBeenCalledTimes(1); // already in: idempotent
    });

    it('refuses an ineligible student, a closed competition and an unknown one', async () => {
      prisma.competition.findFirst.mockResolvedValue(row({ classLevels: ['SS3'] }));
      await expect(service.join('u1', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
      prisma.competition.findFirst.mockResolvedValue(row({ status: 'CLOSED', endsAt: new Date(Date.now() - 1000) }));
      await expect(service.join('u1', 'c1')).rejects.toThrow(/already ended/);
      prisma.competition.findFirst.mockResolvedValue(null);
      await expect(service.join('u1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('start', () => {
    it.each([
      ['an XP-window competition', { format: 'XP_WINDOW' }, /not by a sitting/],
      ['one that has not opened', { status: 'PUBLISHED', startsAt: new Date(Date.now() + day), endsAt: new Date(Date.now() + 2 * day) }, /opens/],
      ['one that has closed', { status: 'ACTIVE', startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - day) }, /closed/],
    ])('refuses %s', async (_n, over, hint) => {
      prisma.competition.findFirst.mockResolvedValue(row(over));
      await expect(service.start('u1', 'c1')).rejects.toThrow(hint);
      expect(prisma.quizSession.create).not.toHaveBeenCalled();
    });

    it('refuses an ineligible student before creating anything', async () => {
      prisma.competition.findFirst.mockResolvedValue(row({ type: 'REGIONAL', region: 'NORTH_WEST' }));
      await expect(service.start('u1', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.quizSession.create).not.toHaveBeenCalled();
    });

    it('does not let a student sit twice', async () => {
      prisma.competition.findFirst.mockResolvedValue(row());
      prisma.quizSession.findUnique.mockResolvedValue({ id: 's1', status: 'SUBMITTED', createdAt: new Date(), questionIds: [] });
      await expect(service.start('u1', 'c1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to resume a sitting whose time ran out', async () => {
      prisma.competition.findFirst.mockResolvedValue(row({ timeLimitSec: 600 }));
      prisma.quizSession.findUnique.mockResolvedValue({ id: 's1', status: 'OPEN', createdAt: new Date(Date.now() - 20 * 60_000), questionIds: ['q1'] });
      await expect(service.start('u1', 'c1')).rejects.toThrow(/time for this competition is up/);
    });

    it('creates the sitting with the frozen questions, a deadline, and no answers or explanations in the payload', async () => {
      prisma.competition.findFirst.mockResolvedValue(row());
      prisma.quizSession.findUnique.mockResolvedValue(null);
      prisma.quizSession.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 's1', status: 'OPEN', createdAt: new Date(), ...data }));
      prisma.question.findMany.mockResolvedValue(['q1', 'q2', 'q3'].map((id) => ({
        id, subjectId: 'math', classLevel: 'SS2', questionText: id, explanation: 'secret', difficulty: 1, correctAnswerId: 'a',
        options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
      })));

      const out = await service.start('u1', 'c1');

      const data = prisma.quizSession.create.mock.calls[0][0].data;
      expect(data.competitionId).toBe('c1');
      expect([...data.questionIds].sort()).toEqual(['q1', 'q2', 'q3']);
      expect(data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
      expect(out.questions).toHaveLength(3);
      expect(JSON.stringify(out)).not.toMatch(/secret|correctAnswerId/);
      expect(out.remainingSec).toBeGreaterThan(590);
      expect(prisma.competitionParticipant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS' }) }));
    });
  });

  describe('review', () => {
    it('keeps answers hidden until the competition closes', async () => {
      prisma.competition.findFirst.mockResolvedValue(row());
      await expect(service.review('u1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s for a student who did not sit it', async () => {
      prisma.competition.findFirst.mockResolvedValue(row({ status: 'CLOSED', endsAt: new Date(Date.now() - 1000) }));
      prisma.quizSession.findUnique.mockResolvedValue(null);
      await expect(service.review('u1', 'c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
