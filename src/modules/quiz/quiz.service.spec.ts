import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QuizService } from './quiz.service';

describe('QuizService', () => {
  let prisma: {
    subject: { findUnique: jest.Mock };
    question: { findMany: jest.Mock; findUnique: jest.Mock };
    quizSession: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
    };
    user: { update: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
    subjectStat: { upsert: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let activity: { recordQuestions: jest.Mock; recordXp: jest.Mock };
  let ledger: { grant: jest.Mock; sumSince: jest.Mock };
  let service: QuizService;

  const openSession = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    userId: 'u1',
    subjectId: 'math',
    questionIds: ['q1', 'q2', 'q3'],
    answers: {},
    status: 'OPEN',
    createdAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      subject: { findUnique: jest.fn() },
      question: { findMany: jest.fn(), findUnique: jest.fn() },
      quizSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
      },
      user: { update: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
      subjectStat: { upsert: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    activity = { recordQuestions: jest.fn(), recordXp: jest.fn() };
    ledger = { grant: jest.fn(), sumSince: jest.fn().mockResolvedValue(0) };
    service = new QuizService(prisma as any, activity as any, ledger as any);
  });

  describe('getRandomQuestions', () => {
    it('issues a session and never includes correctAnswerId', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math' });
      prisma.question.findMany.mockResolvedValue([
        {
          id: 'q1',
          subjectId: 'math',
          classLevel: 'SS1',
          questionText: '2+2?',
          explanation: null,
          difficulty: 1,
          correctAnswerId: 'a',
          options: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }],
        },
      ]);
      prisma.quizSession.create.mockResolvedValue({ id: 's1' });

      const result = await service.getRandomQuestions('u1', 'math', 10, 'SS1' as any);

      expect(prisma.quizSession.create).toHaveBeenCalledWith({
        data: { userId: 'u1', subjectId: 'math', questionIds: ['q1'] },
        select: { id: true },
      });
      expect(result[0].sessionId).toBe('s1');
      expect(result[0]).not.toHaveProperty('correctAnswerId');
      expect(result[0].options).toEqual([{ id: 'a', text: '4' }, { id: 'b', text: '5' }]);
    });

    it('does not create a session when there are no questions', async () => {
      prisma.subject.findUnique.mockResolvedValue({ id: 'math' });
      prisma.question.findMany.mockResolvedValue([]);
      expect(await service.getRandomQuestions('u1', 'math', 10, 'SS1' as any)).toEqual([]);
      expect(prisma.quizSession.create).not.toHaveBeenCalled();
    });

    it('throws for an unknown subject', async () => {
      prisma.subject.findUnique.mockResolvedValue(null);
      await expect(
        service.getRandomQuestions('u1', 'ghost', 10, 'SS1' as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('checkAnswer', () => {
    it('locks the answer and reports correct for a matching option', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(openSession());
      prisma.quizSession.findUniqueOrThrow.mockResolvedValue({ answers: { q1: 'a' } });
      prisma.question.findUnique.mockResolvedValue({
        correctAnswerId: 'a',
        explanation: 'because reasons',
      });

      const result = await service.checkAnswer('u1', 's1', 'q1', 'a');

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        correct: true,
        correctOptionId: 'a',
        explanation: 'because reasons',
      });
    });

    it('replays the first locked answer instead of accepting a retry', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(openSession({ answers: { q1: 'b' } }));
      // The conditional UPDATE matches nothing (already answered)...
      prisma.$executeRaw.mockResolvedValue(0);
      prisma.quizSession.findUniqueOrThrow.mockResolvedValue({ answers: { q1: 'b' } });
      prisma.question.findUnique.mockResolvedValue({ correctAnswerId: 'a', explanation: null });

      // ...so asking again with the right option still reports the first, wrong one.
      const result = await service.checkAnswer('u1', 's1', 'q1', 'a');
      expect(result.correct).toBe(false);
    });

    it('rejects a question that is not in the session', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(openSession());
      await expect(service.checkAnswer('u1', 's1', 'other', 'a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects someone else\'s, unknown, submitted or expired sessions', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(null);
      await expect(service.checkAnswer('u1', 'nope', 'q1', 'a')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.quizSession.findFirst.mockResolvedValue(openSession({ status: 'SUBMITTED' }));
      await expect(service.checkAnswer('u1', 's1', 'q1', 'a')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      prisma.quizSession.findFirst.mockResolvedValue(
        openSession({ createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000) }),
      );
      await expect(service.checkAnswer('u1', 's1', 'q1', 'a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('gradeAndCloseSession', () => {
    beforeEach(() => {
      prisma.quizSession.updateMany.mockResolvedValue({ count: 1 });
      prisma.question.findMany.mockResolvedValue([
        { id: 'q1', correctAnswerId: 'a' },
        { id: 'q2', correctAnswerId: 'b' },
        { id: 'q3', correctAnswerId: 'c' },
      ]);
    });

    it('grades only the session\'s questions from the real answer key', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(openSession());

      const graded = await service.gradeAndCloseSession('u1', 's1', [
        { questionId: 'q1', selectedOptionId: 'a' }, // right
        { questionId: 'q2', selectedOptionId: 'x' }, // wrong
        { questionId: 'ghost', selectedOptionId: 'a' }, // not in session: ignored
      ]);

      expect(graded.questionIds).toEqual(['q1', 'q2', 'q3']);
      expect(graded.correctIds).toEqual(['q1']); // q3 unanswered = wrong
    });

    it('prefers the answer locked in by a check over the submitted one', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(openSession({ answers: { q1: 'wrong' } }));

      const graded = await service.gradeAndCloseSession('u1', 's1', [
        { questionId: 'q1', selectedOptionId: 'a' }, // would be right, but q1 was locked wrong
      ]);

      expect(graded.correctIds).toEqual([]);
    });

    it('cannot count the same question twice', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(openSession());

      const graded = await service.gradeAndCloseSession('u1', 's1', [
        { questionId: 'q1', selectedOptionId: 'a' },
        { questionId: 'q1', selectedOptionId: 'a' },
        { questionId: 'q1', selectedOptionId: 'a' },
      ]);

      expect(graded.correctIds).toEqual(['q1']);
    });

    it('rejects a session that was already closed by a concurrent submit', async () => {
      prisma.quizSession.findFirst.mockResolvedValue(openSession());
      prisma.quizSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.gradeAndCloseSession('u1', 's1', [])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('submitQuizResults', () => {
    const graded = {
      sessionId: 's1',
      subjectId: 'math',
      questionIds: ['q1', 'q2', 'q3'],
      correctIds: ['q1', 'q3'],
    };

    beforeEach(() => {
      jest.spyOn(service, 'gradeAndCloseSession').mockResolvedValue(graded);
      jest.spyOn(service, 'rewardQuizCorrects').mockResolvedValue({ earnedXp: 20, earnedCoins: 20 });
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        coins: 120,
        xp: 120,
        questionsAnswered: 3,
        state: null,
      });
      prisma.user.findUnique.mockResolvedValue({ accuracy: 0, questionsAnswered: 0 });
      prisma.user.count.mockResolvedValue(0);
    });

    it('reports the graded and paid amounts, and records activity', async () => {
      const result = await service.submitQuizResults('u1', {
        sessionId: 's1',
        answers: [],
        timeTaken: 60,
      });

      expect(result.correctAnswers).toBe(2);
      expect(result.earnedCoins).toBe(20);
      expect(result.earnedXp).toBe(20);
      expect(activity.recordXp).toHaveBeenCalledWith('u1', 20);
      expect(activity.recordQuestions).toHaveBeenCalledWith('u1', 3);
      // Balances are the ledger's job - this update must not touch them.
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('coins');
      expect(data).not.toHaveProperty('xp');
    });

    it('computes real national/state ranks by XP', async () => {
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        coins: 100,
        xp: 100,
        questionsAnswered: 3,
        state: 'Lagos',
      });
      // First count() = national (STUDENT, xp > 100); second = same-state.
      prisma.user.count.mockResolvedValueOnce(9).mockResolvedValueOnce(3);

      const result = await service.submitQuizResults('u1', {
        sessionId: 's1',
        answers: [],
        timeTaken: 10,
      });

      expect(result.nationalRank).toBe(10);
      expect(result.stateRank).toBe(4);
      expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
        where: { role: 'STUDENT', state: 'Lagos', xp: { gt: 100 } },
      });
    });

    it('leaves stateRank null when the student has no state set', async () => {
      const result = await service.submitQuizResults('u1', {
        sessionId: 's1',
        answers: [],
        timeTaken: 10,
      });

      expect(result.stateRank).toBeNull();
      expect(prisma.user.count).toHaveBeenCalledTimes(1);
    });
  });
});
