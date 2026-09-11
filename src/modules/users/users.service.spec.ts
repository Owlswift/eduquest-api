import { UsersService } from './users.service';

describe('UsersService.getLeaderboard', () => {
  let prisma: {
    user: { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
    dailyActivity: { groupBy: jest.Mock };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
      dailyActivity: { groupBy: jest.fn() },
    };
    service = new UsersService(prisma as any, {} as any, {} as any);
  });


  it('ranks the top rows and marks the current user', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'a', fullName: 'Aisha Bello', xp: 300 },
      { id: 'me', fullName: 'ola law', xp: 120 },
      { id: 'c', fullName: '', xp: 0 },
    ]);
    prisma.user.findUnique.mockResolvedValue({ fullName: 'ola law', xp: 120 });
    prisma.user.count.mockResolvedValue(1); // one student ahead of me

    const result = await service.getLeaderboard('me');

    expect(result.top).toEqual([
      { rank: 1, name: 'Aisha', xp: 300, isMe: false },
      { rank: 2, name: 'Ola', xp: 120, isMe: true },
      { rank: 3, name: 'Student', xp: 0, isMe: false },
    ]);
    expect(result.me).toEqual({ rank: 2, name: 'Ola', xp: 120 });
  });

  it('returns a null me entry when the user is missing', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue(null);

    const result = await service.getLeaderboard('ghost');

    expect(result.top).toEqual([]);
    expect(result.me).toBeNull();
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('ranks a weekly window by XP earned in that window, not lifetime total', async () => {
    prisma.dailyActivity.groupBy.mockResolvedValue([
      { userId: 'a', _sum: { xpEarned: 90 } },
      { userId: 'me', _sum: { xpEarned: 150 } },
      { userId: 'idle', _sum: { xpEarned: 0 } }, // active row, but earned nothing
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'a', fullName: 'Aisha Bello' },
      { id: 'me', fullName: 'ola law' },
    ]);

    const result = await service.getLeaderboard('me', 20, 'weekly');

    expect(result.top).toEqual([
      { rank: 1, name: 'Ola', xp: 150, isMe: true },
      { rank: 2, name: 'Aisha', xp: 90, isMe: false },
    ]);
    expect(result.me).toEqual({ rank: 1, name: 'Ola', xp: 150 });
    // Zero-XP-in-window rows are excluded - they can't be meaningfully ranked.
    expect(result.top.find((r) => r.name === 'Student')).toBeUndefined();
  });

  it('gives a null me entry for a monthly window when the user had no activity', async () => {
    prisma.dailyActivity.groupBy.mockResolvedValue([
      { userId: 'a', _sum: { xpEarned: 50 } },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'a', fullName: 'Aisha Bello' }]);

    const result = await service.getLeaderboard('me', 20, 'monthly');

    expect(result.me).toBeNull();
    expect(result.top).toEqual([{ rank: 1, name: 'Aisha', xp: 50, isMe: false }]);
  });
});

describe('UsersService.getSubjectProgress', () => {
  let prisma: {
    studentMastery: { groupBy: jest.Mock };
    subject: { findMany: jest.Mock };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      studentMastery: { groupBy: jest.fn() },
      subject: { findMany: jest.fn() },
    };
    service = new UsersService(prisma as any, {} as any, {} as any);
  });

  it('averages mastery per subject, sorted highest first', async () => {
    prisma.studentMastery.groupBy.mockResolvedValue([
      { subjectId: 'math', _avg: { masteryScore: 40 } },
      { subjectId: 'english', _avg: { masteryScore: 75 } },
    ]);
    prisma.subject.findMany.mockResolvedValue([
      { id: 'math', name: 'Mathematics' },
      { id: 'english', name: 'English' },
    ]);

    const result = await service.getSubjectProgress('u1');

    expect(result).toEqual([
      { subjectId: 'english', subjectName: 'English', progress: 0.75 },
      { subjectId: 'math', subjectName: 'Mathematics', progress: 0.4 },
    ]);
  });

  it('returns an empty list when the student has never studied', async () => {
    prisma.studentMastery.groupBy.mockResolvedValue([]);

    const result = await service.getSubjectProgress('u1');

    expect(result).toEqual([]);
    expect(prisma.subject.findMany).not.toHaveBeenCalled();
  });
});

describe('UsersService.completeStarterChallenge', () => {
  let prisma: {
    question: { findMany: jest.Mock };
    user: { update: jest.Mock; count: jest.Mock };
  };
  let activity: { recordQuestions: jest.Mock; recordXp: jest.Mock };
  let notifications: { notify: jest.Mock };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      question: { findMany: jest.fn() },
      user: { update: jest.fn(), count: jest.fn() },
    };
    activity = { recordQuestions: jest.fn(), recordXp: jest.fn() };
    notifications = { notify: jest.fn() };
    service = new UsersService(prisma as any, activity as any, notifications as any);
  });

  it('grades server-side from real correctAnswerId values', async () => {
    prisma.question.findMany.mockResolvedValue([
      { id: 'q1', correctAnswerId: 'a' },
      { id: 'q2', correctAnswerId: 'b' },
    ]);
    prisma.user.update.mockResolvedValue({
      id: 'u1',
      coins: 20,
      xp: 20,
      questionsAnswered: 2,
      badges: 1,
    });
    prisma.user.count.mockResolvedValue(10);

    const result = await service.completeStarterChallenge('u1', [
      { questionId: 'q1', selectedOptionId: 'a' }, // correct
      { questionId: 'q2', selectedOptionId: 'x' }, // wrong
    ]);

    expect(result.correctAnswers).toBe(1);
    expect(result.earnedCoins).toBe(10);
    expect(result.earnedXp).toBe(10);
    expect(result.questionsAnsweredInChallenge).toBe(2);
    expect(activity.recordXp).toHaveBeenCalledWith('u1', 10);
    expect(notifications.notify).toHaveBeenCalledWith(
      'u1',
      'badge_earned',
      expect.any(String),
      expect.any(String),
    );
  });
});
