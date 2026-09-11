import { NotFoundException } from '@nestjs/common';
import { QuizService } from './quiz.service';

describe('QuizService', () => {
  let prisma: {
    subject: { findUnique: jest.Mock };
    question: { findMany: jest.Mock };
    user: { update: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
  };
  let activity: { recordQuestions: jest.Mock; recordXp: jest.Mock };
  let service: QuizService;

  beforeEach(() => {
    prisma = {
      subject: { findUnique: jest.fn() },
      question: { findMany: jest.fn() },
      user: { update: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    };
    activity = { recordQuestions: jest.fn(), recordXp: jest.fn() };
    service = new QuizService(prisma as any, activity as any);
  });

  describe('getRandomQuestions', () => {
    it('never includes correctAnswerId in the response', async () => {
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

      const result = await service.getRandomQuestions('math', 10, 'SS1' as any);

      expect(result[0]).not.toHaveProperty('correctAnswerId');
      expect(result[0].options).toEqual([{ id: 'a', text: '4' }, { id: 'b', text: '5' }]);
    });

    it('throws for an unknown subject', async () => {
      prisma.subject.findUnique.mockResolvedValue(null);
      await expect(service.getRandomQuestions('ghost', 10, 'SS1' as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('checkAnswer', () => {
    it('reports correct for a matching option, without affecting scoring', async () => {
      prisma.question.findMany.mockResolvedValue([]); // not used by this method
      (prisma as any).question.findUnique = jest.fn().mockResolvedValue({
        correctAnswerId: 'a',
        explanation: 'because reasons',
      });

      const result = await service.checkAnswer('q1', 'a');

      expect(result).toEqual({
        correct: true,
        correctOptionId: 'a',
        explanation: 'because reasons',
      });
    });

    it('reports incorrect for a non-matching option', async () => {
      (prisma as any).question.findUnique = jest
        .fn()
        .mockResolvedValue({ correctAnswerId: 'a', explanation: null });

      const result = await service.checkAnswer('q1', 'b');
      expect(result.correct).toBe(false);
      expect(result.correctOptionId).toBe('a');
    });

    it('throws for an unknown question', async () => {
      (prisma as any).question.findUnique = jest.fn().mockResolvedValue(null);
      await expect(service.checkAnswer('ghost', 'a')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('submitQuizResults', () => {
    it('grades server-side from the real correctAnswerId, ignoring any client claim', async () => {
      prisma.question.findMany.mockResolvedValue([
        { id: 'q1', correctAnswerId: 'a' },
        { id: 'q2', correctAnswerId: 'b' },
        { id: 'q3', correctAnswerId: 'c' },
      ]);
      prisma.user.update.mockResolvedValue({ id: 'u1', coins: 120, xp: 120, questionsAnswered: 3 });
      prisma.user.findUnique.mockResolvedValue({ accuracy: 0, questionsAnswered: 0 });
      prisma.user.count.mockResolvedValue(0);

      const result = await service.submitQuizResults('u1', {
        subjectId: 'math',
        // q1 right, q2 wrong, q3 right - only 2 of 3, even though a
        // malicious client could have sent any "correctAnswers" number
        // under the old contract.
        answers: [
          { questionId: 'q1', selectedOptionId: 'a' },
          { questionId: 'q2', selectedOptionId: 'x' },
          { questionId: 'q3', selectedOptionId: 'c' },
        ],
        timeTaken: 60,
      });

      expect(result.correctAnswers).toBe(2);
      expect(result.earnedCoins).toBe(20);
      expect(result.earnedXp).toBe(20);
      expect(activity.recordXp).toHaveBeenCalledWith('u1', 20);
      expect(activity.recordQuestions).toHaveBeenCalledWith('u1', 3);

      const updateArg = prisma.user.update.mock.calls[0][0];
      expect(updateArg.data.coins).toEqual({ increment: 20 });
      expect(updateArg.data.xp).toEqual({ increment: 20 });
    });

    it('scores an unrecognised questionId as wrong rather than crashing', async () => {
      prisma.question.findMany.mockResolvedValue([{ id: 'q1', correctAnswerId: 'a' }]);
      prisma.user.update.mockResolvedValue({ id: 'u1', coins: 0, xp: 0, questionsAnswered: 1 });
      prisma.user.findUnique.mockResolvedValue({ accuracy: 0, questionsAnswered: 0 });
      prisma.user.count.mockResolvedValue(0);

      const result = await service.submitQuizResults('u1', {
        subjectId: 'math',
        answers: [{ questionId: 'ghost-question', selectedOptionId: 'a' }],
        timeTaken: 10,
      });

      expect(result.correctAnswers).toBe(0);
      expect(result.earnedCoins).toBe(0);
    });
  });
});
