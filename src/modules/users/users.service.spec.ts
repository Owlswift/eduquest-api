import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UsersService } from './users.service';

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
    service = new UsersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
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
    user: {
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let activity: { recordQuestions: jest.Mock; recordXp: jest.Mock };
  let notifications: { notify: jest.Mock };
  let ledger: { grant: jest.Mock };
  let quiz: { gradeAndCloseSession: jest.Mock };
  let achievements: { evaluate: jest.Mock };
  let service: UsersService;

  const graded = (correctIds: string[], total = 2) => ({
    sessionId: 's1',
    subjectId: 'math',
    questionIds: Array.from({ length: total }, (_, i) => `q${i + 1}`),
    correctIds,
  });

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ starterChallengeCompletedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: any) => cb({}));
    prisma.user.update.mockResolvedValue({});
    // 1st call: the "already completed?" pre-check; later calls: the final read.
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ starterChallengeCompletedAt: null })
      .mockResolvedValue({ id: 'u1', coins: 10, xp: 100, questionsAnswered: 2, badges: 1, state: null });
    prisma.user.count.mockResolvedValue(2);
    achievements = { evaluate: jest.fn().mockResolvedValue([]) };
    activity = { recordQuestions: jest.fn(), recordXp: jest.fn() };
    notifications = { notify: jest.fn() };
    ledger = { grant: jest.fn().mockResolvedValue({ applied: true, xp: 10, coins: 10 }) };
    quiz = { gradeAndCloseSession: jest.fn().mockResolvedValue(graded(['q1'])) };
    service = new UsersService(
      prisma as any,
      activity as any,
      notifications as any,
      ledger as any,
      quiz as any,
      achievements as any,
    );
  });

  it('grades the issued session and pays one ledger award per correct answer', async () => {
    const answers = [
      { questionId: 'q1', selectedOptionId: 'a' },
      { questionId: 'q2', selectedOptionId: 'x' },
    ];
    const result = await service.completeStarterChallenge('u1', 's1', answers);

    expect(quiz.gradeAndCloseSession).toHaveBeenCalledWith('u1', 's1', answers, 'STARTER');
    expect(ledger.grant).toHaveBeenCalledTimes(1);
    expect(ledger.grant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', xp: 10, coins: 10, key: 'starter:u1:q1' }),
      expect.anything(),
    );
    expect(result.correctAnswers).toBe(1);
    expect(result.earnedCoins).toBe(10);
    expect(result.earnedXp).toBe(10);
    expect(result.questionsAnsweredInChallenge).toBe(2);
    expect(activity.recordXp).toHaveBeenCalledWith('u1', 10);
    // Badges now come from the achievements engine, which notifies by itself.
    expect(achievements.evaluate).toHaveBeenCalledWith('u1');
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('returns what the starter challenge unlocked and the new level', async () => {
    achievements.evaluate.mockResolvedValue([
      { key: 'first_steps', name: 'First Steps', description: 'd', icon: 'level1_badge' },
    ]);
    const result = await service.completeStarterChallenge('u1', 's1', []);
    expect(result.newAchievements).toEqual([
      { key: 'first_steps', name: 'First Steps', description: 'd', icon: 'level1_badge' },
    ]);
    expect(result.level.level).toBe(1);
  });

  it('can only be completed once per account', async () => {
    prisma.user.findUniqueOrThrow.mockReset();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ starterChallengeCompletedAt: new Date() });

    await expect(service.completeStarterChallenge('u1', 's1', [])).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(quiz.gradeAndCloseSession).not.toHaveBeenCalled();
    expect(ledger.grant).not.toHaveBeenCalled();
  });

  it('pays nothing when a concurrent request already completed it', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.completeStarterChallenge('u1', 's1', [])).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(ledger.grant).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('caps how many correct answers the starter challenge pays for', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `q${i + 1}`);
    quiz.gradeAndCloseSession.mockResolvedValue({
      sessionId: 's1',
      subjectId: 'math',
      questionIds: ids,
      correctIds: ids,
    });

    await service.completeStarterChallenge('u1', 's1', []);

    expect(ledger.grant).toHaveBeenCalledTimes(10);
  });

  it('computes real ranks by XP instead of the old Math.random() placeholders', async () => {
    prisma.user.findUniqueOrThrow.mockReset();
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ starterChallengeCompletedAt: null })
      .mockResolvedValue({ id: 'u1', coins: 10, xp: 100, questionsAnswered: 2, badges: 1, state: 'Lagos' });
    // First count() call = national (STUDENT, xp > 100); second = same-state.
    prisma.user.count.mockReset();
    prisma.user.count.mockResolvedValueOnce(4).mockResolvedValueOnce(1);

    const result = await service.completeStarterChallenge('u1', 's1', []);

    expect(result.nationalRank).toBe(5);
    expect(result.stateRank).toBe(2);
    expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
      where: { role: 'STUDENT', state: 'Lagos', xp: { gt: 100 } },
    });
  });

  it('leaves stateRank null (not fabricated) when the student has no state set', async () => {
    const result = await service.completeStarterChallenge('u1', 's1', []);

    expect(result.stateRank).toBeNull();
    expect(prisma.user.count).toHaveBeenCalledTimes(1); // no state query at all
  });
});

describe('UsersService.claimWelcomeBonus', () => {
  let prisma: { user: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock } };
  let activity: { recordXp: jest.Mock };
  let notifications: { notify: jest.Mock };
  let ledger: { grant: jest.Mock };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'u1', coins: 100, xp: 50, streak: 1 }),
      },
    };
    activity = { recordXp: jest.fn() };
    notifications = { notify: jest.fn() };
    ledger = { grant: jest.fn() };
    service = new UsersService(
      prisma as any,
      activity as any,
      notifications as any,
      ledger as any,
      {} as any,
      {} as any,
    );
  });

  it('pays 100 coins + 50 XP through the ledger the first time', async () => {
    const result = await service.claimWelcomeBonus('u1');

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', welcomeBonusClaimedAt: null },
      data: { welcomeBonusClaimedAt: expect.any(Date), streak: 1 },
    });
    expect(ledger.grant).toHaveBeenCalledWith({
      userId: 'u1',
      xp: 50,
      coins: 100,
      reason: 'welcome_bonus',
      key: 'welcome_bonus:u1',
    });
    expect(result).toMatchObject({ alreadyClaimed: false, bonusCoins: 100, bonusXp: 50 });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('pays nothing on a repeat claim', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.claimWelcomeBonus('u1');

    expect(ledger.grant).not.toHaveBeenCalled();
    expect(activity.recordXp).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alreadyClaimed: true, bonusCoins: 0, bonusXp: 0 });
  });
});

describe('UsersService.changePassword', () => {
  let prisma: { user: { findUnique: jest.Mock; update: jest.Mock } };
  let service: UsersService;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
    service = new UsersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
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
    const service = new UsersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);

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
    service = new UsersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
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

describe('UsersService.updateProfile subjects', () => {
  let prisma: { subject: { findMany: jest.Mock }; user: { update: jest.Mock } };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      subject: { findMany: jest.fn() },
      user: { update: jest.fn().mockResolvedValue({ id: 'u1', interests: null, subjects: '["math"]' }) },
    };
    service = new UsersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  });

  it('rejects an unknown subject id and writes nothing', async () => {
    prisma.subject.findMany.mockResolvedValue([{ id: 'math' }]);
    await expect(service.updateProfile('u1', { subjects: ['math', 'matsh'] } as any)).rejects.toThrow(/Unknown subject: matsh/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('stores each subject once', async () => {
    prisma.subject.findMany.mockResolvedValue([{ id: 'math' }]);
    await service.updateProfile('u1', { subjects: ['math', 'math'] } as any);
    expect(prisma.user.update.mock.calls[0][0].data.subjects).toBe('["math"]');
  });
});
