import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminCompetitionsService } from './admin-competitions.service';

describe('AdminCompetitionsService', () => {
  let prisma: any;
  let audit: { log: jest.Mock; history: jest.Mock };
  let service: AdminCompetitionsService;
  const day = 86_400_000;
  const iso = (d: number) => new Date(Date.now() + d * day).toISOString();
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'c1', title: 'June Challenge', subtitle: 's', description: null, prizes: [], type: 'MONTHLY', format: 'FIXED_SET', status: 'DRAFT',
    startsAt: new Date(Date.now() + 2 * day), endsAt: new Date(Date.now() + 9 * day), createdAt: new Date(),
    classLevels: [], subjectIds: [], state: null, region: null, questionCount: 10, questionIds: [], pointsPerCorrect: 1,
    penaltyPerWrong: 0, timeLimitSec: null, participationXp: 0, participationCoins: 0, claimDeadlineDays: 14,
    publishedAt: null, finalisedAt: null, prizeList: [], _count: { participants: 0 }, ...over,
  });
  const create = (over: Record<string, unknown> = {}) => ({
    title: 'June Challenge', subtitle: 's', type: 'MONTHLY', questionCount: 10, startsAt: iso(2), endsAt: iso(9),
    prizes: [{ positionFrom: 1, positionTo: 1, title: '1GB data', kind: 'DATA' }], ...over,
  });

  beforeEach(() => {
    prisma = {
      competition: { findMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), delete: jest.fn() },
      competitionParticipant: { count: jest.fn().mockResolvedValue(0) },
      competitionPrize: { deleteMany: jest.fn(), createMany: jest.fn() },
      question: { findMany: jest.fn() },
      subject: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    audit = { log: jest.fn().mockResolvedValue(undefined), history: jest.fn().mockResolvedValue([]) };
    service = new AdminCompetitionsService(prisma, audit as any);
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.competition.create.mockResolvedValue(row());
      prisma.competition.findUnique.mockResolvedValue(row());
    });

    it('creates a fixed-set DRAFT, records the prizes as rows and audits it', async () => {
      await service.create('admin1', create({ title: ' June Challenge ', timeLimitMinutes: 30 }) as any);
      const data = prisma.competition.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ title: 'June Challenge', format: 'FIXED_SET', status: 'DRAFT', timeLimitSec: 1800, pointsPerCorrect: 1, penaltyPerWrong: 0 });
      expect(data.prizeList.create).toEqual([{ positionFrom: 1, positionTo: 1, title: '1GB data', kind: 'DATA', coinAmount: null, sortOrder: 0 }]);
      expect(data.prizes).toEqual(['1GB data']); // text list kept for older clients
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'competition.create', adminId: 'admin1' }));
    });

    it.each([
      ['an end before the start', { startsAt: iso(5), endsAt: iso(2) }, /after the start/],
      ['an unreadable date', { startsAt: 'nope' }, /Invalid date/],
      ['a state competition with no state', { type: 'STATE' }, /needs a state/],
      ['a regional competition with no region', { type: 'REGIONAL' }, /needs a region/],
      ['overlapping prizes', { prizes: [{ positionFrom: 1, positionTo: 3, title: 'a', kind: 'OTHER' }, { positionFrom: 3, positionTo: 4, title: 'b', kind: 'OTHER' }] }, /overlap/],
      ['a coin prize with no amount', { prizes: [{ positionFrom: 1, positionTo: 1, title: 'Coins', kind: 'COINS' }] }, /needs an amount/],
      ['a time limit longer than the competition', { timeLimitMinutes: 240, startsAt: iso(2), endsAt: new Date(Date.now() + 2 * day + 3_600_000).toISOString() }, /longer than the competition/],
    ])('rejects %s', async (_n, over, hint) => {
      await expect(service.create('a', create(over) as any)).rejects.toThrow(hint);
      expect(prisma.competition.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown subject', async () => {
      await expect(service.create('a', create({ subjectIds: ['ghost'] }) as any)).rejects.toThrow(/Unknown subject: ghost/);
    });

    it('keeps the state only for state competitions', async () => {
      prisma.competition.findUnique.mockResolvedValue(row({ type: 'STATE', state: 'Lagos' }));
      await service.create('a', create({ type: 'STATE', state: 'Lagos' }) as any);
      expect(prisma.competition.create.mock.calls[0][0].data).toMatchObject({ state: 'Lagos', region: null });
    });
  });

  describe('update by stage', () => {
    it('lets a draft change anything, including scoring', async () => {
      prisma.competition.findUnique.mockResolvedValue(row());
      prisma.competition.update.mockResolvedValue(row({ pointsPerCorrect: 2 }));
      await service.update('a', 'c1', { pointsPerCorrect: 2, penaltyPerWrong: 1, questionCount: 20 });
      expect(prisma.competition.update.mock.calls[0][0].data).toMatchObject({ pointsPerCorrect: 2, penaltyPerWrong: 1, questionCount: 20 });
    });

    it('freezes scoring and eligibility once published, but allows copy, dates and prizes', async () => {
      prisma.competition.findUnique.mockResolvedValue(row({ status: 'PUBLISHED', questionIds: ['q1'] }));
      prisma.competition.update.mockResolvedValue(row({ status: 'PUBLISHED' }));
      await expect(service.update('a', 'c1', { pointsPerCorrect: 5 })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.update('a', 'c1', { classLevels: ['SS1'] as any })).rejects.toThrow(/rules are fixed/);
      await service.update('a', 'c1', { title: 'New name', startsAt: iso(3), endsAt: iso(10), prizes: [{ positionFrom: 1, positionTo: 1, title: 'Tablet', kind: 'DEVICE' }] });
      expect(prisma.competitionPrize.deleteMany).toHaveBeenCalledWith({ where: { competitionId: 'c1' } });
    });

    it('allows only wording changes while running, and nothing after it ends', async () => {
      prisma.competition.findUnique.mockResolvedValue(row({ status: 'ACTIVE', startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day) }));
      prisma.competition.update.mockResolvedValue(row({ status: 'ACTIVE' }));
      await expect(service.update('a', 'c1', { endsAt: iso(30) })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.update('a', 'c1', { prizes: [] })).rejects.toBeInstanceOf(ConflictException);
      await service.update('a', 'c1', { subtitle: 'Fixed a typo' });
      expect(prisma.competition.update).toHaveBeenCalled();

      prisma.competition.findUnique.mockResolvedValue(row({ status: 'FINALISED', endsAt: new Date(Date.now() - day), startsAt: new Date(Date.now() - 5 * day) }));
      await expect(service.update('a', 'c1', { title: 'xyz' })).rejects.toThrow(/finished/);
    });

    it('404s for an unknown competition', async () => {
      prisma.competition.findUnique.mockResolvedValue(null);
      await expect(service.update('a', 'ghost', { title: 'abc' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('publish', () => {
    const pool = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `q${i}` }));

    it('freezes the rules by picking the questions', async () => {
      prisma.competition.findUnique.mockResolvedValue(row({ classLevels: ['SS2'], subjectIds: ['math'] }));
      prisma.question.findMany.mockResolvedValue(pool(15));
      await service.publish('admin1', 'c1');
      expect(prisma.question.findMany.mock.calls[0][0].where).toEqual({ status: 'PUBLISHED', classLevel: { in: ['SS2'] }, subjectId: { in: ['math'] } });
      const data = prisma.competition.updateMany.mock.calls[0][0].data;
      expect(data.status).toBe('PUBLISHED');
      expect(data.questionIds).toHaveLength(10);
      expect(new Set(data.questionIds).size).toBe(10);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'competition.publish' }));
    });

    it('refuses when there are not enough published questions, and says how many', async () => {
      prisma.competition.findUnique.mockResolvedValue(row());
      prisma.question.findMany.mockResolvedValue(pool(4));
      await expect(service.publish('a', 'c1')).rejects.toThrow(/Only 4 published questions match, but the competition needs 10/);
      expect(prisma.competition.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to publish something already published, or whose dates have passed', async () => {
      prisma.competition.findUnique.mockResolvedValue(row({ status: 'PUBLISHED' }));
      await expect(service.publish('a', 'c1')).rejects.toBeInstanceOf(ConflictException);
      prisma.competition.findUnique.mockResolvedValue(row({ startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day) }));
      await expect(service.publish('a', 'c1')).rejects.toThrow(/start date has passed/);
      prisma.competition.findUnique.mockResolvedValue(row({ startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - day) }));
      await expect(service.publish('a', 'c1')).rejects.toThrow(/end date has passed/);
    });

    it('loses cleanly when two admins publish at once', async () => {
      prisma.competition.findUnique.mockResolvedValue(row());
      prisma.question.findMany.mockResolvedValue(pool(12));
      prisma.competition.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.publish('a', 'c1')).rejects.toBeInstanceOf(ConflictException);
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('close early', () => {
    it('only closes a running competition, with the reason on record', async () => {
      prisma.competition.findUnique.mockResolvedValue(row({ status: 'ACTIVE', startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day) }));
      await service.closeNow('admin1', 'c1', 'A question had the wrong key');
      expect(prisma.competition.update.mock.calls[0][0].data.status).toBe('CLOSED');
      expect(audit.log.mock.calls[0][0].summary).toMatch(/wrong key/);

      prisma.competition.findUnique.mockResolvedValue(row());
      await expect(service.closeNow('a', 'c1', 'because')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes a draft, but not a competition students have entered, or a finished one', async () => {
      prisma.competition.findUnique.mockResolvedValue(row());
      await expect(service.remove('a', 'c1')).resolves.toEqual({ deleted: true });

      prisma.competition.findUnique.mockResolvedValue(row({ status: 'PUBLISHED', _count: { participants: 12 } }));
      await expect(service.remove('a', 'c1')).rejects.toThrow(/12 students/);

      prisma.competition.findUnique.mockResolvedValue(row({ status: 'FINALISED', startsAt: new Date(Date.now() - 9 * day), endsAt: new Date(Date.now() - 2 * day) }));
      await expect(service.remove('a', 'c1')).rejects.toThrow(/kept as a record/);
    });
  });

  it('follows the clock when listing', async () => {
    prisma.competition.findMany.mockResolvedValue([
      row({ id: 'soon', status: 'PUBLISHED' }),
      row({ id: 'on', status: 'PUBLISHED', startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day) }),
      row({ id: 'over', status: 'ACTIVE', startsAt: new Date(Date.now() - 9 * day), endsAt: new Date(Date.now() - day) }),
    ]);
    const rows = await service.list();
    expect(rows.map((r) => [r.id, r.status, r.editable])).toEqual([
      ['soon', 'PUBLISHED', 'schedule_and_prizes'],
      ['on', 'ACTIVE', 'wording'],
      ['over', 'CLOSED', 'none'],
    ]);
    expect(prisma.competition.updateMany).toHaveBeenCalledTimes(2); // persisted, conditional on the old status
  });
});
