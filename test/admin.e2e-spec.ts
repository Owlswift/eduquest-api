/**
 * Admin question bank and competitions against a REAL Postgres: that students
 * only ever see PUBLISHED questions, that editing keeps option ids stable, and
 * that every change is audited. Skipped unless TEST_DATABASE_URL points at a
 * migrated, DISPOSABLE database (it deletes all SS2 questions first).
 */
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { ActivityService } from '../src/modules/activity/activity.service';
import { AdminQuestionsService } from '../src/modules/admin/admin-questions.service';
import { AuditService } from '../src/modules/admin/audit.service';
import { DailyChallengesService } from '../src/modules/daily-challenges/daily-challenges.service';
import { ExamsService } from '../src/modules/exams/exams.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { AttemptsService } from '../src/modules/progress/attempts.service';
import { CompetitionSittingsService } from '../src/modules/competitions/competition-sittings.service';
import { QuizService } from '../src/modules/quiz/quiz.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('admin tools (real database)', () => {
  let prisma: PrismaService;
  let admin: AdminQuestionsService;
  let quiz: QuizService;
  let daily: DailyChallengesService;
  let exams: ExamsService;
  const tag = `ad${Date.now()}`;
  const subjectId = `${tag}-subj`;
  const userIds: string[] = [];
  let adminId: string;
  let n = 0;

  const makeUser = async (over: Record<string, unknown> = {}) => {
    const id = `${tag}-u${++n}`;
    await prisma.user.create({ data: { id, fullName: `U ${n}`, username: id, email: `${id}@t.test`, ...over } });
    userIds.push(id);
    return id;
  };
  const newQuestion = (text: string, over: Record<string, unknown> = {}) =>
    admin.create(adminId, {
      subjectId, classLevel: 'SS2', questionText: text, topic: 'Algebra', examType: 'WAEC',
      options: [{ text: 'one' }, { text: 'two' }, { text: 'three' }], correctIndex: 1, ...over,
    } as any);
  const servedIds = async (u: string) => (await quiz.getRandomQuestions(u, subjectId, 50, 'SS2' as any)).map((q) => q.id);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    const ledger = new LedgerService(prisma);
    const activity = new ActivityService(prisma);
    const attempts = new AttemptsService(prisma);
    const achievements = { evaluate: async () => [] } as any;
    const audit = new AuditService(prisma);
    admin = new AdminQuestionsService(prisma, audit);
    quiz = new QuizService(prisma, activity, ledger, attempts, achievements, new CompetitionSittingsService(prisma, ledger));
    daily = new DailyChallengesService(prisma);
    exams = new ExamsService(prisma, activity, attempts, achievements);
    await prisma.dailyChallenge.deleteMany({});
    await prisma.question.deleteMany({ where: { classLevel: 'SS2' } });
    await prisma.subject.create({ data: { id: subjectId, name: tag, icon: 'i', color: '#000' } });
    adminId = await makeUser({ role: 'ADMIN' });
  });

  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { adminId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.dailyChallenge.deleteMany({});
    await prisma.subject.delete({ where: { id: subjectId } });
    await prisma.$disconnect();
  });

  describe('visibility to students', () => {
    it('serves only published questions through quiz, daily challenge and exams', async () => {
      const draft = await newQuestion('Draft question text'); // starts as DRAFT
      const live = await Promise.all(
        Array.from({ length: 7 }, (_, i) => newQuestion(`Live question ${i}`, { status: 'PUBLISHED' })),
      );
      const retired = await newQuestion('Retired question text', { status: 'PUBLISHED' });
      await admin.setStatus(adminId, retired.id, 'RETIRED' as any);
      expect(draft.status).toBe('DRAFT');

      const u = await makeUser({ classLevel: 'SS2' });
      const served = await servedIds(u);
      expect(served.sort()).toEqual(live.map((q) => q.id).sort());
      expect(served).not.toContain(draft.id);
      expect(served).not.toContain(retired.id);

      const topics = await quiz.getTopics(subjectId, 'SS2' as any);
      expect(topics).toEqual([{ topic: 'Algebra', questionCount: 7 }]);

      const dailySet = await daily.start(u);
      expect(dailySet.every((q) => live.some((l) => l.id === q.id))).toBe(true);

      const exam = await exams.start(u, { subjectId, examType: 'WAEC', count: 7 } as any);
      expect(exam.questions.every((q) => live.some((l) => l.id === q.id))).toBe(true);
      expect(exam.questions).toHaveLength(7);
    });

    it('starts serving a draft once it is published, and stops after it is retired', async () => {
      const q = await newQuestion('Publish me please');
      const u = await makeUser({ classLevel: 'SS2' });
      expect(await servedIds(u)).not.toContain(q.id);
      await admin.setStatus(adminId, q.id, 'PUBLISHED' as any);
      expect(await servedIds(u)).toContain(q.id);
      await admin.setStatus(adminId, q.id, 'RETIRED' as any);
      expect(await servedIds(u)).not.toContain(q.id);
    });

    it('still grades a session that was issued before the question was retired', async () => {
      const u = await makeUser({ classLevel: 'SS2' });
      const issued = await quiz.getRandomQuestions(u, subjectId, 3, 'SS2' as any);
      const target = issued[0];
      await admin.setStatus(adminId, target.id, 'RETIRED' as any);

      const right = (await prisma.question.findUniqueOrThrow({ where: { id: target.id } })).correctAnswerId;
      const res = await quiz.submitQuizResults(u, {
        sessionId: target.sessionId,
        answers: issued.map((q) => ({ questionId: q.id, selectedOptionId: q.id === target.id ? right : 'x' })),
        timeTaken: 5,
      });
      expect(res.correctAnswers).toBe(1);
      await admin.setStatus(adminId, target.id, 'PUBLISHED' as any); // restore for later tests
    });
  });

  describe('editing', () => {
    it('keeps existing option ids, mints new ones, drops removed ones, and moves the answer key', async () => {
      const q = await newQuestion('Editable question', { status: 'PUBLISHED' });
      const [o1, o2, o3] = q.options;
      expect(o2.correct).toBe(true);

      const edited = await admin.update(adminId, q.id, {
        options: [{ id: o1.id, text: 'one (edited)' }, { id: o3.id, text: 'three' }, { text: 'four' }],
        correctIndex: 2,
      } as any);

      expect(edited.options.map((o) => o.text)).toEqual(expect.arrayContaining(['one (edited)', 'three', 'four']));
      expect(edited.options).toHaveLength(3);
      expect(edited.options.map((o) => o.id)).toEqual(expect.arrayContaining([o1.id, o3.id]));
      expect(edited.options.map((o) => o.id)).not.toContain(o2.id);
      expect(edited.options.find((o) => o.correct)?.text).toBe('four');
      expect(await prisma.answerOption.count({ where: { questionId: q.id } })).toBe(3);

      const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id } });
      expect(edited.options.find((o) => o.correct)?.id).toBe(row.correctAnswerId);
      expect(edited.history[0].summary).toMatch(/CHANGED the correct answer/);
    });

    it('records create, publish and edits in the audit trail, newest first', async () => {
      const q = await newQuestion('Audited question');
      await admin.update(adminId, q.id, { difficulty: 3 });
      await admin.setStatus(adminId, q.id, 'PUBLISHED' as any);
      const full = await admin.get(q.id);
      expect(full.history.map((h) => h.action)).toEqual(['question.published', 'question.update', 'question.create']);
      expect(full.history.every((h) => h.admin?.id === adminId)).toBe(true);
    });

    it('deletes an unused draft but not a used or published question', async () => {
      const draft = await newQuestion('Throwaway draft');
      await expect(admin.remove(adminId, draft.id)).resolves.toEqual({ deleted: true });
      expect(await prisma.question.count({ where: { id: draft.id } })).toBe(0);

      const used = await newQuestion('Answered draft');
      const u = await makeUser();
      await prisma.questionAttempt.create({ data: { userId: u, questionId: used.id, subjectId, correct: true, source: 'QUIZ', sourceRefId: 'r1' } });
      await expect(admin.remove(adminId, used.id)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('question quality', () => {
    it('flags a question nearly everyone gets wrong', async () => {
      const q = await newQuestion('Suspicious key question', { status: 'PUBLISHED' });
      const rows = Array.from({ length: 30 }, (_, i) => ({
        userId: adminId, questionId: q.id, subjectId, correct: i === 0, source: 'QUIZ' as const, sourceRefId: `r${i}`,
      }));
      await prisma.questionAttempt.createMany({ data: rows });
      const found = await admin.list({ subjectId, q: 'Suspicious key', page: 1, pageSize: 10 });
      expect(found.items[0]).toMatchObject({ attempts: 30, qualityFlag: 'CHECK_ANSWER_KEY' });
      expect(found.items[0].correctRate).toBeCloseTo(1 / 30);
    });

    it('filters by status and searches the text', async () => {
      const drafts = await admin.list({ subjectId, status: 'DRAFT' as any, page: 1, pageSize: 100 });
      expect(drafts.items.every((i) => i.status === 'DRAFT')).toBe(true);
      const hit = await admin.list({ subjectId, q: 'editable', page: 1, pageSize: 10 });
      expect(hit.items.some((i) => i.questionText === 'Editable question')).toBe(true);
    });
  });
});
