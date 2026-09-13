import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
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

  it('computes real ranks by XP instead of the old Math.random() placeholders', async () => {
    prisma.question.findMany.mockResolvedValue([{ id: 'q1', correctAnswerId: 'a' }]);
    prisma.user.update.mockResolvedValue({
      id: 'u1',
      coins: 10,
      xp: 100,
      questionsAnswered: 1,
      badges: 1,
      state: 'Lagos',
    });
    // First count() call = national (STUDENT, xp > 100); second = same-state.
    prisma.user.count.mockResolvedValueOnce(4).mockResolvedValueOnce(1);

    const result = await service.completeStarterChallenge('u1', [
      { questionId: 'q1', selectedOptionId: 'a' },
    ]);

    expect(result.nationalRank).toBe(5);
    expect(result.stateRank).toBe(2);
    expect(prisma.user.count).toHaveBeenNthCalledWith(1, {
      where: { role: 'STUDENT', xp: { gt: 100 } },
    });
    expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
      where: { role: 'STUDENT', state: 'Lagos', xp: { gt: 100 } },
    });
  });

  it('leaves stateRank null (not fabricated) when the student has no state set', async () => {
    prisma.question.findMany.mockResolvedValue([{ id: 'q1', correctAnswerId: 'a' }]);
    prisma.user.update.mockResolvedValue({
      id: 'u1',
      coins: 10,
      xp: 50,
      questionsAnswered: 1,
      badges: 1,
      state: null,
    });
    prisma.user.count.mockResolvedValue(2);

    const result = await service.completeStarterChallenge('u1', [
      { questionId: 'q1', selectedOptionId: 'a' },
    ]);

    expect(result.stateRank).toBeNull();
    expect(prisma.user.count).toHaveBeenCalledTimes(1); // no state query at all
  });
});

describe('UsersService.changePassword', () => {
  let prisma: { user: { findUnique: jest.Mock; update: jest.Mock } };
  let service: UsersService;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
    service = new UsersService(prisma as any, {} as any, {} as any);
  });

  it('changes the password when the current one is correct', async () => {
    const currentHash = await argon2.hash('oldpass1');
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: currentHash });
    prisma.user.update.mockResolvedValue({});

    const result = await service.changePassword('u1', 'oldpass1', 'newpass1');

    expect(result.message).toMatch(/changed successfully/);
    const arg = prisma.user.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'u1' });
    expect(typeof arg.data.passwordHash).toBe('string');
  });

  it('rejects an incorrect current password', async () => {
    const currentHash = await argon2.hash('oldpass1');
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: currentHash });

    await expect(service.changePassword('u1', 'wrongpass', 'newpass1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects for a Google-only account with no password set', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: null });

    await expect(service.changePassword('u1', 'anything', 'newpass1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('UsersService.deleteAccount', () => {
  it('deletes the user row (cascades handle the rest)', async () => {
    const prisma = { user: { delete: jest.fn().mockResolvedValue({}) } };
    const service = new UsersService(prisma as any, {} as any, {} as any);

    const result = await service.deleteAccount('u1');

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(result.message).toMatch(/deleted/);
  });
});

describe('UsersService.searchStudents', () => {
  let prisma: {
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    challenge: { findMany: jest.Mock };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findMany: jest.fn() },
      challenge: { findMany: jest.fn() },
    };
    service = new UsersService(prisma as any, {} as any, {} as any);
  });

  it('returns nothing for a query shorter than 2 characters', async () => {
    const result = await service.searchStudents('me', 'a');
    expect(result).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('still returns a student in a different class level, but marks them ineligible', async () => {
    prisma.user.findUnique.mockResolvedValue({ classLevel: 'SS1' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'bola', username: 'bola', fullName: 'Bola Ade', avatarUrl: null, classLevel: 'SS3' },
    ]);

    const result = await service.searchStudents('me', 'bola');

    expect(result).toEqual([
      {
        id: 'bola',
        username: 'bola',
        fullName: 'Bola Ade',
        avatarUrl: null,
        classLevel: 'SS3',
        eligible: false,
        ineligibleReason: 'In SS3, not your class level',
      },
    ]);
  });

  it('still returns a student the caller already has an open challenge with, but marks them ineligible', async () => {
    prisma.user.findUnique.mockResolvedValue({ classLevel: 'SS1' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'bola', username: 'bola', fullName: 'Bola Ade', avatarUrl: null, classLevel: 'SS1' },
      { id: 'chidi', username: 'chidi', fullName: 'Chidi Okoro', avatarUrl: null, classLevel: 'SS1' },
    ]);
    prisma.challenge.findMany.mockResolvedValue([{ challengerId: 'me', opponentId: 'bola' }]);

    const result = await service.searchStudents('me', 'oo', 'math');

    expect(result.find((u) => u.id === 'bola')).toMatchObject({
      eligible: false,
      ineligibleReason: expect.stringContaining('open challenge'),
    });
    expect(result.find((u) => u.id === 'chidi')).toMatchObject({ eligible: true, ineligibleReason: null });
  });

  it('does not check for open challenges when no subjectId is given', async () => {
    prisma.user.findUnique.mockResolvedValue({ classLevel: 'SS1' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'bola', username: 'bola', fullName: 'Bola Ade', avatarUrl: null, classLevel: 'SS1' },
    ]);

    const result = await service.searchStudents('me', 'bola');

    expect(result).toEqual([
      {
        id: 'bola', username: 'bola', fullName: 'Bola Ade', avatarUrl: null, classLevel: 'SS1',
        eligible: true, ineligibleReason: null,
      },
    ]);
    expect(prisma.challenge.findMany).not.toHaveBeenCalled();
  });
});
