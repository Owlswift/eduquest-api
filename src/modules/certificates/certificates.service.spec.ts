import { CertificatesService } from './certificates.service';

describe('CertificatesService', () => {
  let prisma: {
    certificate: { findUnique: jest.Mock; findMany: jest.Mock; create: jest.Mock };
    studentMastery: { aggregate: jest.Mock };
    subject: { findUnique: jest.Mock };
    user: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  let notifications: { notify: jest.Mock };
  let service: CertificatesService;

  beforeEach(() => {
    prisma = {
      certificate: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
      studentMastery: { aggregate: jest.fn() },
      subject: { findUnique: jest.fn() },
      user: { update: jest.fn() },
      $transaction: jest.fn(),
    };
    notifications = { notify: jest.fn() };
    service = new CertificatesService(prisma as any, notifications as any, { evaluate: jest.fn().mockResolvedValue([]) } as any);
  });

  describe('checkAndAward', () => {
    it('awards a certificate once mastery crosses the threshold across enough topics', async () => {
      prisma.certificate.findUnique.mockResolvedValue(null);
      prisma.studentMastery.aggregate.mockResolvedValue({
        _avg: { masteryScore: 85 },
        _count: { _all: 3 },
      });
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.$transaction.mockResolvedValue([{}, {}]);

      await service.checkAndAward('u1', 'math');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2); // create + coins bump
      expect(notifications.notify).toHaveBeenCalledWith(
        'u1',
        'certificate_earned',
        expect.any(String),
        expect.stringContaining('Mathematics'),
        { subjectId: 'math' },
      );
    });

    it('does not award below the topic-count minimum, even at high mastery', async () => {
      prisma.certificate.findUnique.mockResolvedValue(null);
      prisma.studentMastery.aggregate.mockResolvedValue({
        _avg: { masteryScore: 95 },
        _count: { _all: 2 }, // below MIN_TOPICS
      });

      await service.checkAndAward('u1', 'math');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('does not award below the mastery threshold, even with enough topics', async () => {
      prisma.certificate.findUnique.mockResolvedValue(null);
      prisma.studentMastery.aggregate.mockResolvedValue({
        _avg: { masteryScore: 60 },
        _count: { _all: 5 },
      });

      await service.checkAndAward('u1', 'math');

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is a no-op if a certificate for this subject already exists', async () => {
      prisma.certificate.findUnique.mockResolvedValue({ id: 'existing' });

      await service.checkAndAward('u1', 'math');

      expect(prisma.studentMastery.aggregate).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('maps certificates to the response shape, newest first', async () => {
      const createdAt = new Date('2026-06-01');
      prisma.certificate.findMany.mockResolvedValue([
        { id: 'c1', kind: 'SUBJECT', subjectId: 'math', subjectName: 'Mathematics', title: null, competitionId: null, rank: null, verificationCode: 'EQ-AAAAA-BBBBB', createdAt },
        { id: 'c2', kind: 'WINNER', subjectId: null, subjectName: 'June Challenge', title: 'Runner-up', competitionId: 'comp1', rank: 2, verificationCode: 'EQ-CCCCC-DDDDD', createdAt },
      ]);

      const result = await service.list('u1');

      // Older clients read id, subjectId, subjectName and earnedAt; the rest is new.
      expect(result[0]).toEqual({
        id: 'c1', subjectId: 'math', subjectName: 'Mathematics', earnedAt: createdAt,
        kind: 'SUBJECT', title: 'Mathematics mastery', competitionId: null, rank: null, verificationCode: 'EQ-AAAAA-BBBBB',
      });
      expect(result[1]).toMatchObject({ kind: 'WINNER', title: 'Runner-up', rank: 2, subjectId: null, competitionId: 'comp1' });
    });
  });
});
