import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ExamsService } from './exams.service';

describe('ExamsService.start', () => {
  let prisma: {
    examSession: { findFirst: jest.Mock; create: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    subject: { findUnique: jest.Mock };
    question: { findMany: jest.Mock };
  };
  let service: ExamsService;
  const ids = (n: number, p = 'q') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }));

  beforeEach(() => {
    prisma = {
      examSession: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
      subject: { findUnique: jest.fn().mockResolvedValue({ id: 'math' }) },
      question: { findMany: jest.fn() },
    };
    prisma.examSession.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'e1', answers: {}, startedAt: data.startedAt, ...data }));
    service = new ExamsService(prisma as any, {} as any, {} as any, {} as any);
  });

  it('rejects an unknown subject', async () => {
    prisma.subject.findUnique.mockResolvedValue(null);
    await expect(service.start('u1', { subjectId: 'x', examType: 'WAEC' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to start while another exam is running, and points at it', async () => {
    prisma.examSession.findFirst.mockResolvedValue({ id: 'e0', endsAt: new Date(Date.now() + 60_000) });
    await expect(service.start('u1', { subjectId: 'math', examType: 'WAEC' } as any)).rejects.toMatchObject({
      response: { examId: 'e0' },
    });
    await expect(service.start('u1', { subjectId: 'math', examType: 'WAEC' } as any)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an exam with too few questions', async () => {
    prisma.question.findMany.mockResolvedValueOnce(ids(3)).mockResolvedValue([]); // 3 past, nothing to top up with
    await expect(service.start('u1', { subjectId: 'math', examType: 'WAEC' } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('defaults to one minute per question and fixes the deadline at start', async () => {
    prisma.question.findMany.mockResolvedValueOnce(ids(12)).mockResolvedValue([]);
    const before = Date.now();
    const exam = await service.start('u1', { subjectId: 'math', examType: 'WAEC', count: 10 } as any);
    expect(exam.durationSec).toBe(600);
    expect(new Date(exam.endsAt).getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(prisma.examSession.create.mock.calls[0][0].data.questionIds).toHaveLength(10);
  });

  it('honours an explicit duration', async () => {
    prisma.question.findMany.mockResolvedValueOnce(ids(12)).mockResolvedValue([]);
    const exam = await service.start('u1', { subjectId: 'math', examType: 'JAMB', count: 10, durationMinutes: 25 } as any);
    expect(exam.durationSec).toBe(1500);
  });
});
