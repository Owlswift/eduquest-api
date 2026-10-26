import { ConflictException, NotFoundException } from '@nestjs/common';
import { DailyChallengesService, DAILY_REWARDS } from './daily-challenges.service';

describe('DailyChallengesService', () => {
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock };
    dailyChallenge: { findUnique: jest.Mock; createMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    quizSession: { findUnique: jest.Mock; create: jest.Mock; findUniqueOrThrow: jest.Mock };
    question: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let service: DailyChallengesService;
  const challenge = { id: 'c1', date: new Date('2026-10-26'), classLevel: 'SS2', questionIds: ['q1', 'q2', 'q3', 'q4', 'q5'] };
  const now = new Date('2026-10-26T10:00:00Z');

  beforeEach(() => {
    prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ classLevel: 'SS2' }) },
      dailyChallenge: { findUnique: jest.fn(), createMany: jest.fn(), findUniqueOrThrow: jest.fn() },
      quizSession: { findUnique: jest.fn(), create: jest.fn(), findUniqueOrThrow: jest.fn() },
      question: { findMany: jest.fn() },
      $queryRaw: jest.fn(),
    };
    service = new DailyChallengesService(prisma as any);
  });

  it('reuses today\'s challenge instead of drawing new questions', async () => {
    prisma.dailyChallenge.findUnique.mockResolvedValue(challenge);
    await service.getOrCreate('SS2' as any, now);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.dailyChallenge.createMany).not.toHaveBeenCalled();
  });

  it('is unavailable when the class level has too few questions', async () => {
    prisma.dailyChallenge.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);
    expect(await service.getOrCreate('SS2' as any, now)).toBeNull();
    expect((await service.status('u1', now)).state).toBe('UNAVAILABLE');
    await expect(service.start('u1', now)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('inserts with skipDuplicates so a simultaneous first request cannot create two', async () => {
    prisma.dailyChallenge.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue(challenge.questionIds.map((id) => ({ id })));
    prisma.dailyChallenge.findUniqueOrThrow.mockResolvedValue(challenge);
    await service.getOrCreate('SS2' as any, now);
    expect(prisma.dailyChallenge.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  describe('status', () => {
    beforeEach(() => prisma.dailyChallenge.findUnique.mockResolvedValue(challenge));

    it('is AVAILABLE before the student starts', async () => {
      prisma.quizSession.findUnique.mockResolvedValue(null);
      const s = await service.status('u1', now);
      expect(s).toMatchObject({ state: 'AVAILABLE', questionCount: 5, rewards: DAILY_REWARDS });
      expect(s.resetsAt.toISOString()).toBe('2026-10-26T23:00:00.000Z'); // midnight in Lagos
    });

    it('is IN_PROGRESS with the session to resume', async () => {
      prisma.quizSession.findUnique.mockResolvedValue({ id: 's1', status: 'OPEN', createdAt: new Date(now.getTime() - 60_000) });
      expect(await service.status('u1', now)).toMatchObject({ state: 'IN_PROGRESS', sessionId: 's1' });
    });

    it('is EXPIRED when an open attempt outlived its session', async () => {
      prisma.quizSession.findUnique.mockResolvedValue({ id: 's1', status: 'OPEN', createdAt: new Date(now.getTime() - 4 * 3600_000) });
      expect((await service.status('u1', now)).state).toBe('EXPIRED');
    });

    it('is COMPLETED with the score', async () => {
      prisma.quizSession.findUnique.mockResolvedValue({ id: 's1', status: 'SUBMITTED', correctCount: 4, createdAt: now });
      expect(await service.status('u1', now)).toMatchObject({ state: 'COMPLETED', result: { correct: 4, total: 5 } });
    });
  });

  describe('start', () => {
    beforeEach(() => {
      prisma.dailyChallenge.findUnique.mockResolvedValue(challenge);
      prisma.question.findMany.mockResolvedValue(
        challenge.questionIds.map((id) => ({ id, subjectId: 'math', classLevel: 'SS2', questionText: id, explanation: null, difficulty: 1, correctAnswerId: 'x', options: [{ id: `${id}a`, text: 'A' }] })),
      );
    });

    it('refuses a second attempt once completed', async () => {
      prisma.quizSession.findUnique.mockResolvedValue({ id: 's1', status: 'SUBMITTED', createdAt: now });
      await expect(service.start('u1', now)).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates the attempt as a session tied to the challenge and hides answers', async () => {
      prisma.quizSession.findUnique.mockResolvedValue(null);
      prisma.quizSession.create.mockResolvedValue({ id: 's9', status: 'OPEN', createdAt: now });
      const qs = await service.start('u1', now);
      expect(prisma.quizSession.create).toHaveBeenCalledWith({
        data: { userId: 'u1', dailyChallengeId: 'c1', subjectId: 'daily', questionIds: challenge.questionIds },
      });
      expect(qs).toHaveLength(5);
      expect(qs[0]).toMatchObject({ sessionId: 's9' });
      expect(qs[0]).not.toHaveProperty('correctAnswerId');
    });
  });
});
