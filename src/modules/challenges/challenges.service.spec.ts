import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChallengesService } from './challenges.service';

describe('ChallengesService', () => {
  let prisma: {
    subject: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    challenge: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    question: { findMany: jest.Mock };
    subjectStat: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock };
  };
  let notifications: { notify: jest.Mock };
  let service: ChallengesService;

  beforeEach(() => {
    prisma = {
      subject: { findUnique: jest.fn() },
      user: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
      challenge: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      question: { findMany: jest.fn() },
      subjectStat: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    };
    prisma.subjectStat.upsert.mockResolvedValue({});
    notifications = { notify: jest.fn() };
    service = new ChallengesService(prisma as any, notifications as any);
  });

  describe('create', () => {
    it('rejects challenging yourself', async () => {
      await expect(
        service.create('u1', { opponentId: 'u1', subjectId: 'math', topics: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a PENDING challenge with the challenger classLevel and notifies the opponent', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.user.findUnique.mockImplementation(({ where }: any) =>
        where.id === 'opp'
          ? Promise.resolve({ id: 'opp', fullName: 'Bola Ade', role: 'STUDENT', classLevel: 'SS1' })
          : Promise.resolve({ fullName: 'Ola Law', classLevel: 'SS1' }),
      );
      prisma.challenge.findFirst.mockResolvedValue(null); // no open challenge already between them
      prisma.challenge.create.mockResolvedValue({ id: 'c1', status: 'PENDING' });

      const result = await service.create('me', {
        opponentId: 'opp',
        subjectId: 'math',
        topics: ['Algebra', 'Geometry'],
      });

      expect(result).toEqual({ id: 'c1', status: 'PENDING' });
      expect(prisma.challenge.create.mock.calls[0][0].data).toMatchObject({
        subjectId: 'math',
        classLevel: 'SS1',
        challengerId: 'me',
        opponentId: 'opp',
        challengerTopics: ['Algebra', 'Geometry'],
      });
      expect(notifications.notify).toHaveBeenCalledWith(
        'opp',
        'challenge_received',
        expect.any(String),
        expect.stringContaining('Mathematics'),
        { challengeId: 'c1' },
      );
    });

    it('throws for an unknown subject', async () => {
      prisma.subject.findUnique.mockResolvedValue(null);
      await expect(
        service.create('me', { opponentId: 'opp', subjectId: 'ghost', topics: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the opponent is not a student (or does not exist)', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.create('me', { opponentId: 'ghost', subjectId: 'math', topics: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects challenging a student in a different class level', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.user.findUnique.mockImplementation(({ where }: any) =>
        where.id === 'opp'
          ? Promise.resolve({ id: 'opp', fullName: 'Bola Ade', role: 'STUDENT', classLevel: 'SS3' })
          : Promise.resolve({ fullName: 'Ola Law', classLevel: 'SS1' }),
      );

      await expect(
        service.create('me', { opponentId: 'opp', subjectId: 'math', topics: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.challenge.create).not.toHaveBeenCalled();
    });

    it('rejects a second open challenge with the same student for the same subject', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.user.findUnique.mockImplementation(({ where }: any) =>
        where.id === 'opp'
          ? Promise.resolve({ id: 'opp', fullName: 'Bola Ade', role: 'STUDENT', classLevel: 'SS1' })
          : Promise.resolve({ fullName: 'Ola Law', classLevel: 'SS1' }),
      );
      prisma.challenge.findFirst.mockResolvedValue({ id: 'existing-open-challenge' });

      await expect(
        service.create('me', { opponentId: 'opp', subjectId: 'math', topics: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.challenge.create).not.toHaveBeenCalled();
    });
  });

  describe('respond', () => {
    const baseChallenge = {
      id: 'c1',
      challengerId: 'me',
      opponentId: 'opp',
      subjectId: 'math',
      classLevel: 'SS1',
      challengerTopics: ['Algebra', 'Geometry'],
      status: 'PENDING',
    };

    it('weights shared topics higher when generating the question pool', async () => {
      prisma.challenge.findUnique.mockResolvedValue(baseChallenge);
      // Algebra: shared (weight 2). Geometry: challenger-only (weight 1).
      // Probability: opponent-only (weight 1). 15 total slots, weight 2:1:1
      // -> 7.5/3.75/3.75 exact, largest-remainder rounds to 7/4/4.
      prisma.question.findMany.mockImplementation(({ where }: any) => {
        if (where.topic === 'Algebra') {
          return Promise.resolve(
            Array.from({ length: 10 }, (_, i) => ({ id: `alg${i}`, options: [] })),
          );
        }
        if (where.topic === 'Geometry') {
          return Promise.resolve(
            Array.from({ length: 10 }, (_, i) => ({ id: `geo${i}`, options: [] })),
          );
        }
        if (where.topic === 'Probability') {
          return Promise.resolve(
            Array.from({ length: 10 }, (_, i) => ({ id: `prob${i}`, options: [] })),
          );
        }
        // The final findMany call fetches the frozen question set with options,
        // filtered by id: { in: [...] } rather than topic.
        return Promise.resolve(
          (where.id.in as string[]).map((id: string) => ({
            id,
            options: [{ id: `${id}_a` }, { id: `${id}_b` }],
          })),
        );
      });
      prisma.user.findUnique.mockResolvedValue({ fullName: 'Bola Ade' });
      prisma.challenge.update.mockResolvedValue({});

      await service.respond('opp', 'c1', ['Algebra', 'Probability']);

      const updateArg = prisma.challenge.update.mock.calls[0][0];
      expect(updateArg.data.status).toBe('ACTIVE');
      const pool: string[] = updateArg.data.questionIds;
      expect(pool).toHaveLength(15);
      const algCount = pool.filter((id) => id.startsWith('alg')).length;
      const geoCount = pool.filter((id) => id.startsWith('geo')).length;
      const probCount = pool.filter((id) => id.startsWith('prob')).length;
      expect(algCount).toBe(7);
      expect(geoCount).toBe(4);
      expect(probCount).toBe(4);
    });

    it('gives each player an independently randomized option order for the same questions', async () => {
      prisma.challenge.findUnique.mockResolvedValue({ ...baseChallenge, challengerTopics: [] });
      prisma.question.findMany.mockImplementation(({ where }: any) => {
        if (where.id?.in) {
          return Promise.resolve(
            where.id.in.map((id: string) => ({
              id,
              options: [{ id: `${id}_a` }, { id: `${id}_b` }, { id: `${id}_c` }, { id: `${id}_d` }],
            })),
          );
        }
        // No topics selected by either side -> falls back to the whole pool.
        return Promise.resolve(Array.from({ length: 20 }, (_, i) => ({ id: `q${i}` })));
      });
      prisma.user.findUnique.mockResolvedValue({ fullName: 'Bola Ade' });
      prisma.challenge.update.mockResolvedValue({});

      await service.respond('opp', 'c1', []);

      const { challengerOptionOrder, opponentOptionOrder } = prisma.challenge.update.mock.calls[0][0].data;
      const someQuestionId = Object.keys(challengerOptionOrder)[0];
      // Both orders contain the same 4 option ids for every question...
      expect([...challengerOptionOrder[someQuestionId]].sort()).toEqual(
        [...opponentOptionOrder[someQuestionId]].sort(),
      );
    });

    it('rejects a response from someone who is not the opponent', async () => {
      prisma.challenge.findUnique.mockResolvedValue(baseChallenge);
      await expect(service.respond('someone-else', 'c1', [])).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects responding twice', async () => {
      prisma.challenge.findUnique.mockResolvedValue({ ...baseChallenge, status: 'ACTIVE' });
      await expect(service.respond('opp', 'c1', [])).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getQuestions', () => {
    it('never includes correctAnswerId, and orders options per-player', async () => {
      prisma.challenge.findUnique.mockResolvedValue({
        challengerId: 'me',
        opponentId: 'opp',
        status: 'ACTIVE',
        challengerCompletedAt: null,
        opponentCompletedAt: null,
        questionIds: ['q1'],
        challengerOptionOrder: { q1: ['q1_c', 'q1_a', 'q1_b'] },
        opponentOptionOrder: { q1: ['q1_a', 'q1_b', 'q1_c'] },
      });
      prisma.question.findMany.mockResolvedValue([
        {
          id: 'q1',
          topic: 'Algebra',
          questionText: '2+2?',
          explanation: 'basic addition',
          difficulty: 1,
          correctAnswerId: 'q1_b',
          options: [
            { id: 'q1_a', text: '3' },
            { id: 'q1_b', text: '4' },
            { id: 'q1_c', text: '5' },
          ],
        },
      ]);

      const result = await service.getQuestions('me', 'c1');

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('correctAnswerId');
      expect(result[0].options.map((o) => o.id)).toEqual(['q1_c', 'q1_a', 'q1_b']);
    });

    it('rejects fetching questions for a challenge that is not ACTIVE', async () => {
      prisma.challenge.findUnique.mockResolvedValue({
        challengerId: 'me',
        opponentId: 'opp',
        status: 'PENDING',
      });
      await expect(service.getQuestions('me', 'c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-participant', async () => {
      prisma.challenge.findUnique.mockResolvedValue({
        challengerId: 'a',
        opponentId: 'b',
        status: 'ACTIVE',
      });
      await expect(service.getQuestions('stranger', 'c1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('submitAnswers', () => {
    const activeChallenge = {
      id: 'c1',
      challengerId: 'me',
      opponentId: 'opp',
      status: 'ACTIVE',
      questionIds: ['q1', 'q2'],
      challengerCompletedAt: null,
      opponentCompletedAt: null,
      challengerScore: null,
      opponentScore: null,
    };

    it('grades server-side from the real answer key, not a client-reported score', async () => {
      prisma.challenge.findUnique.mockResolvedValue(activeChallenge);
      prisma.question.findMany.mockResolvedValue([
        { id: 'q1', correctAnswerId: 'q1_b' },
        { id: 'q2', correctAnswerId: 'q2_a' },
      ]);
      prisma.challenge.update.mockResolvedValue({ ...activeChallenge, challengerScore: 1 });
      prisma.user.update.mockResolvedValue({});

      const result = await service.submitAnswers('me', 'c1', [
        { questionId: 'q1', selectedOptionId: 'q1_b' }, // correct
        { questionId: 'q2', selectedOptionId: 'q2_z' }, // wrong
      ]);

      expect(result.score).toBe(1);
      expect(result.waitingOnOpponent).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'me' },
        data: { xp: { increment: 10 }, coins: { increment: 10 } },
      });
      // First submitter doesn't complete the challenge on their own.
      expect(prisma.challenge.update.mock.calls[0][0].data.status).toBeUndefined();
    });

    it('completes the challenge and awards a win bonus once both sides have answered', async () => {
      prisma.challenge.findUnique.mockResolvedValue({
        ...activeChallenge,
        opponentCompletedAt: new Date('2026-01-01'),
        opponentScore: 1,
      });
      prisma.question.findMany.mockResolvedValue([
        { id: 'q1', correctAnswerId: 'q1_b' },
        { id: 'q2', correctAnswerId: 'q2_a' },
      ]);
      prisma.challenge.update.mockResolvedValue({
        id: 'c1',
        challengerId: 'me',
        opponentId: 'opp',
        challengerScore: 2,
        opponentScore: 1,
      });
      prisma.user.update.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ fullName: 'Someone' });

      const result = await service.submitAnswers('me', 'c1', [
        { questionId: 'q1', selectedOptionId: 'q1_b' },
        { questionId: 'q2', selectedOptionId: 'q2_a' },
      ]);

      expect(result.waitingOnOpponent).toBe(false);
      expect(prisma.challenge.update.mock.calls[0][0].data.status).toBe('COMPLETED');
      // Base reward (2 correct x 10) plus the winner's bonus, in two separate calls.
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'me' },
        data: { xp: { increment: 20 }, coins: { increment: 20 } },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'me' },
        data: { xp: { increment: 50 }, coins: { increment: 20 } },
      });
      expect(notifications.notify).toHaveBeenCalledTimes(2);
    });

    it('rejects submitting twice', async () => {
      prisma.challenge.findUnique.mockResolvedValue({
        ...activeChallenge,
        challengerCompletedAt: new Date('2026-01-01'),
      });
      await expect(service.submitAnswers('me', 'c1', [])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('suggestOpponents', () => {
    beforeEach(() => {
      // No topic history for anyone in these tests - keeps the topic
      // score a constant 0.3 across candidates so ability differences
      // are what drive ranking, not incidental topic overlap.
      prisma.challenge.findMany.mockResolvedValue([]);
    });

    it('throws for an unknown subject', async () => {
      prisma.subject.findUnique.mockResolvedValue(null);
      await expect(service.suggestOpponents('me', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ranks candidates of similar subject-specific ability above distant ones', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      // I'm a 75% Mathematics performer (15/20).
      prisma.subjectStat.findUnique.mockResolvedValue({ questionsAnswered: 20, correctAnswers: 15 });
      prisma.user.findMany.mockResolvedValue([
        { id: 'close1' }, { id: 'close2' }, { id: 'far1' }, { id: 'far2' },
      ]);
      prisma.subjectStat.findMany.mockResolvedValue([
        { userId: 'close1', questionsAnswered: 20, correctAnswers: 15, lastActiveAt: new Date() }, // 75%
        { userId: 'close2', questionsAnswered: 20, correctAnswers: 14, lastActiveAt: new Date() }, // 70%
        { userId: 'far1', questionsAnswered: 20, correctAnswers: 2, lastActiveAt: new Date() }, // 10%
        { userId: 'far2', questionsAnswered: 20, correctAnswers: 19, lastActiveAt: new Date() }, // 95%
      ]);

      const result = await service.suggestOpponents('me', 'math');
      const rankedIds = [...result.recommended, ...result.discover].map((c) => c.userId);

      // Both close candidates outrank both far candidates.
      expect(rankedIds.indexOf('close1')).toBeLessThan(rankedIds.indexOf('far1'));
      expect(rankedIds.indexOf('close1')).toBeLessThan(rankedIds.indexOf('far2'));
      expect(rankedIds.indexOf('close2')).toBeLessThan(rankedIds.indexOf('far1'));
      expect(rankedIds.indexOf('close2')).toBeLessThan(rankedIds.indexOf('far2'));
    });

    it('shows "New" (null ability) for a candidate without enough graded answers yet', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.subjectStat.findUnique.mockResolvedValue({ questionsAnswered: 20, correctAnswers: 15 });
      prisma.user.findMany.mockResolvedValue([{ id: 'rookie' }]);
      prisma.subjectStat.findMany.mockResolvedValue([
        { userId: 'rookie', questionsAnswered: 2, correctAnswers: 2, lastActiveAt: new Date() }, // below the minimum
      ]);

      const result = await service.suggestOpponents('me', 'math');
      const rookie = [...result.recommended, ...result.discover].find((c) => c.userId === 'rookie');

      expect(rookie?.abilityPercent).toBeNull();
    });

    it('never puts the same candidate in both recommended and discover', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.subjectStat.findUnique.mockResolvedValue(null);
      const candidates = Array.from({ length: 30 }, (_, i) => ({ id: `u${i}` }));
      prisma.user.findMany.mockResolvedValue(candidates);
      prisma.subjectStat.findMany.mockResolvedValue(
        candidates.map((c, i) => ({
          userId: c.id,
          questionsAnswered: 20,
          correctAnswers: i, // spread of abilities
          lastActiveAt: new Date(),
        })),
      );

      const result = await service.suggestOpponents('me', 'math');
      const recommendedIds = new Set(result.recommended.map((c) => c.userId));
      const discoverIds = result.discover.map((c) => c.userId);

      expect(result.recommended).toHaveLength(5);
      expect(result.discover).toHaveLength(5);
      for (const id of discoverIds) expect(recommendedIds.has(id)).toBe(false);
    });

    it('generates the same pseudonym for the same student every time', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math', name: 'Mathematics' });
      prisma.subjectStat.findUnique.mockResolvedValue(null);
      prisma.user.findMany.mockResolvedValue([{ id: 'stable-user-id' }]);
      prisma.subjectStat.findMany.mockResolvedValue([]);

      const first = await service.suggestOpponents('me', 'math');
      const second = await service.suggestOpponents('me', 'math');

      const firstPseudonym = [...first.recommended, ...first.discover][0].pseudonym;
      const secondPseudonym = [...second.recommended, ...second.discover][0].pseudonym;
      expect(firstPseudonym).toBe(secondPseudonym);
    });
  });

  describe('getResults', () => {
    it('rejects viewing results before both players have finished', async () => {
      prisma.challenge.findUnique.mockResolvedValue({
        challengerId: 'me',
        opponentId: 'opp',
        status: 'ACTIVE',
        challenger: { id: 'me', fullName: 'Me' },
        opponent: { id: 'opp', fullName: 'Opp' },
      });
      await expect(service.getResults('me', 'c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reports the winner and per-player XP/coins including the win bonus', async () => {
      prisma.challenge.findUnique.mockResolvedValue({
        challengerId: 'me',
        opponentId: 'opp',
        status: 'COMPLETED',
        subjectId: 'math',
        completedAt: new Date('2026-01-01'),
        questionIds: ['q1', 'q2', 'q3'],
        challengerScore: 3,
        opponentScore: 1,
        challenger: { id: 'me', fullName: 'Ola Law' },
        opponent: { id: 'opp', fullName: 'Bola Ade' },
      });

      const result = await service.getResults('me', 'c1');

      expect(result.isDraw).toBe(false);
      expect(result.challenger).toMatchObject({
        won: true,
        correctCount: 3,
        earnedXp: 30 + 50,
        earnedCoins: 30 + 20,
      });
      expect(result.opponent).toMatchObject({
        won: false,
        correctCount: 1,
        earnedXp: 10,
        earnedCoins: 10,
      });
    });
  });
});
