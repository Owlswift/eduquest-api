import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminQuestionsService } from './admin-questions.service';

describe('AdminQuestionsService', () => {
  let prisma: any;
  let audit: { log: jest.Mock; history: jest.Mock };
  let service: AdminQuestionsService;

  const base = {
    subjectId: 'math',
    classLevel: 'SS1' as any,
    questionText: 'What is 2 + 2?',
    options: [{ text: '3' }, { text: '4' }, { text: '5' }],
    correctIndex: 1,
  };
  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'q1', subjectId: 'math', classLevel: 'SS1', topic: null, questionText: 'What is 2 + 2?', explanation: null,
    difficulty: 1, examType: null, examYear: null, status: 'DRAFT', correctAnswerId: 'o2',
    createdAt: new Date(), updatedAt: new Date(),
    options: [{ id: 'o1', text: '3' }, { id: 'o2', text: '4' }, { id: 'o3', text: '5' }],
    ...over,
  });

  beforeEach(() => {
    prisma = {
      subject: { findUnique: jest.fn().mockResolvedValue({ id: 'math' }) },
      question: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
      questionAttempt: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      answerOption: { deleteMany: jest.fn(), upsert: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    audit = { log: jest.fn().mockResolvedValue(undefined), history: jest.fn().mockResolvedValue([]) };
    service = new AdminQuestionsService(prisma, audit as any);
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.question.create.mockImplementation(({ data }: any) =>
        Promise.resolve(stored({ id: 'q1', status: data.status, correctAnswerId: data.correctAnswerId, options: data.options.create })),
      );
      prisma.question.findUnique.mockImplementation(() => Promise.resolve(stored()));
    });

    it('starts as a draft and points the answer key at the chosen option', async () => {
      await service.create('admin1', base as any);
      const data = prisma.question.create.mock.calls[0][0].data;
      expect(data.status).toBe('DRAFT');
      expect(data.options.create).toHaveLength(3);
      expect(data.correctAnswerId).toBe(data.options.create[1].id);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'question.create', adminId: 'admin1' }));
    });

    it.each([
      ['an unknown subject', { subjectId: 'ghost' }, 'subject'],
      ['a blank option', { options: [{ text: 'a' }, { text: '  ' }] }, 'blank'],
      ['duplicate options', { options: [{ text: 'A' }, { text: ' a ' }] }, 'same text'],
      ['an answer index outside the options', { correctIndex: 3 }, 'correctIndex'],
    ])('rejects %s', async (_name, over, hint) => {
      if (over.subjectId) prisma.subject.findUnique.mockResolvedValue(null);
      await expect(service.create('admin1', { ...base, ...over } as any)).rejects.toThrow(new RegExp(hint, 'i'));
      expect(prisma.question.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.question.findUnique.mockResolvedValue(stored({ status: 'PUBLISHED' }));
      prisma.question.update.mockImplementation(({ data }: any) => Promise.resolve(stored({ status: 'PUBLISHED', ...(data.correctAnswerId && { correctAnswerId: data.correctAnswerId }) })));
    });

    it('needs options and correctIndex together', async () => {
      await expect(service.update('a', 'q1', { correctIndex: 0 } as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update('a', 'q1', { options: [{ text: 'x' }, { text: 'y' }] } as any)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps existing option ids (so past answers still point at them), mints new ones and drops the rest', async () => {
      await service.update('a', 'q1', {
        options: [{ id: 'o1', text: '3' }, { id: 'o2', text: 'four' }, { text: 'six' }],
        correctIndex: 2,
      } as any);
      expect(prisma.answerOption.deleteMany).toHaveBeenCalledWith({
        where: { questionId: 'q1', id: { notIn: expect.arrayContaining(['o1', 'o2']) } },
      });
      expect(prisma.answerOption.upsert).toHaveBeenCalledTimes(3);
      const keep = prisma.answerOption.deleteMany.mock.calls[0][0].where.id.notIn;
      expect(keep).toHaveLength(3);
      expect(keep).not.toContain('o3'); // dropped
    });

    it('refuses an option id from another question', async () => {
      await expect(
        service.update('a', 'q1', { options: [{ id: 'foreign', text: 'x' }, { text: 'y' }], correctIndex: 0 } as any),
      ).rejects.toThrow(/does not belong/);
    });

    it('records when the correct answer changed', async () => {
      await service.update('a', 'q1', { options: [{ id: 'o1', text: '3' }, { id: 'o2', text: '4' }], correctIndex: 0 } as any);
      expect(audit.log.mock.calls[0][0].summary).toMatch(/CHANGED the correct answer/);
    });

    it('404s for an unknown question', async () => {
      prisma.question.findUnique.mockResolvedValue(null);
      await expect(service.update('a', 'ghost', { difficulty: 2 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setStatus', () => {
    it('will not publish a question whose key is not among its options', async () => {
      prisma.question.findUnique.mockResolvedValue(stored({ correctAnswerId: 'gone' }));
      await expect(service.setStatus('a', 'q1', 'PUBLISHED' as any)).rejects.toThrow(/correct answer/);
      expect(prisma.question.update).not.toHaveBeenCalled();
    });

    it('will not publish with fewer than two options', async () => {
      prisma.question.findUnique.mockResolvedValue(stored({ options: [{ id: 'o2', text: '4' }] }));
      await expect(service.setStatus('a', 'q1', 'PUBLISHED' as any)).rejects.toThrow(/two options/);
    });

    it('publishes and audits a valid draft, and retiring needs no checks', async () => {
      prisma.question.findUnique.mockResolvedValue(stored());
      prisma.question.update.mockResolvedValue({});
      await service.setStatus('a', 'q1', 'PUBLISHED' as any);
      expect(prisma.question.update).toHaveBeenCalledWith({ where: { id: 'q1' }, data: { status: 'PUBLISHED' } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'question.published', before: { status: 'DRAFT' }, after: { status: 'PUBLISHED' } }));

      prisma.question.findUnique.mockResolvedValue(stored({ status: 'PUBLISHED', correctAnswerId: 'gone' }));
      await expect(service.setStatus('a', 'q1', 'RETIRED' as any)).resolves.toBeDefined();
    });
  });

  describe('remove', () => {
    it('deletes only an unused draft', async () => {
      prisma.question.findUnique.mockResolvedValue(stored());
      await expect(service.remove('a', 'q1')).resolves.toEqual({ deleted: true });

      prisma.question.findUnique.mockResolvedValue(stored({ status: 'PUBLISHED' }));
      await expect(service.remove('a', 'q1')).rejects.toBeInstanceOf(ConflictException);

      prisma.question.findUnique.mockResolvedValue(stored());
      prisma.questionAttempt.count.mockResolvedValue(3);
      await expect(service.remove('a', 'q1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('list quality flags', () => {
    it('flags a question nearly everyone gets wrong, once there is enough evidence', async () => {
      prisma.question.count.mockResolvedValue(3);
      prisma.question.findMany.mockResolvedValue([stored({ id: 'hard' }), stored({ id: 'easy' }), stored({ id: 'new' })]);
      prisma.questionAttempt.groupBy
        .mockResolvedValueOnce([{ questionId: 'hard', _count: { _all: 40 } }, { questionId: 'easy', _count: { _all: 50 } }, { questionId: 'new', _count: { _all: 4 } }])
        .mockResolvedValueOnce([{ questionId: 'hard', _count: { _all: 2 } }, { questionId: 'easy', _count: { _all: 50 } }, { questionId: 'new', _count: { _all: 0 } }]);
      const res = await service.list({ page: 1, pageSize: 25 });
      const by = Object.fromEntries(res.items.map((i) => [i.id, i]));
      expect(by.hard).toMatchObject({ attempts: 40, qualityFlag: 'CHECK_ANSWER_KEY' });
      expect(by.easy.qualityFlag).toBe('TOO_EASY');
      expect(by.new.qualityFlag).toBeNull(); // too few answers to judge
      expect(by.hard.options.find((o: any) => o.correct)?.id).toBe('o2');
    });

    it('caps the page size', async () => {
      prisma.question.count.mockResolvedValue(0);
      prisma.question.findMany.mockResolvedValue([]);
      const res = await service.list({ page: 0, pageSize: 5000 });
      expect(res).toMatchObject({ page: 1, pageSize: 100 });
    });
  });
});
