import { UsersService } from './users.service';

describe('UsersService.getLeaderboard', () => {
  let prisma: {
    user: { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    };
    service = new UsersService(prisma as any, {} as any);
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
    service = new UsersService(prisma as any, {} as any);
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
