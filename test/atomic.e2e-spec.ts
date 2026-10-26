/**
 * Simultaneous writes to the same per-student, per-day or per-subject row,
 * against a REAL Postgres. Skipped unless TEST_DATABASE_URL points at a
 * migrated, disposable database.
 */
import { PrismaService } from '../src/database/prisma.service';
import { ActivityService } from '../src/modules/activity/activity.service';
import { CompetitionSittingsService } from '../src/modules/competitions/competition-sittings.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { AttemptsService } from '../src/modules/progress/attempts.service';
import { QuizService } from '../src/modules/quiz/quiz.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('concurrent writes (real database)', () => {
  let prisma: PrismaService;
  let activity: ActivityService;
  const tag = `at${Date.now()}`;
  const userIds: string[] = [];
  const make = async () => {
    const id = `${tag}-u${userIds.length}`;
    await prisma.user.create({ data: { id, fullName: 'A B', username: id, email: `${id}@t.test` } });
    userIds.push(id);
    return id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    activity = new ActivityService(prisma);
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('records every answer when a student\'s first activity of the day arrives twice at once', async () => {
    const u = await make();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => activity.recordQuestions(u, 3)));
    expect(results.filter((r) => r.status === 'rejected').map((r: any) => String(r.reason?.message).slice(0, 80))).toEqual([]);
    const rows = await prisma.dailyActivity.findMany({ where: { userId: u } });
    expect(rows).toHaveLength(1);
    expect(rows[0].questionsAnswered).toBe(36);
  });

  it('does the same for XP and lessons', async () => {
    const u = await make();
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => activity.recordXp(u, 10)),
      ...Array.from({ length: 6 }, () => activity.recordLesson(u)),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    const row = await prisma.dailyActivity.findFirstOrThrow({ where: { userId: u } });
    expect(row).toMatchObject({ xpEarned: 60, lessonsStudied: 6 });
  });

  it('keeps a subject tally right when two quizzes in the same subject finish at the same moment', async () => {
    const ledger = new LedgerService(prisma);
    const quiz = new QuizService(prisma, activity, ledger, new AttemptsService(prisma), { evaluate: async () => [] } as any, new CompetitionSittingsService(prisma, ledger));
    const subjectId = `${tag}-subj`;
    await prisma.subject.create({ data: { id: subjectId, name: tag, icon: 'i', color: '#000' } });
    for (let i = 0; i < 8; i++) {
      const id = `${tag}-q${i}`;
      await prisma.question.create({ data: { id, subjectId, classLevel: 'SS1', questionText: `Q${i}`, correctAnswerId: `${id}_a`, options: { create: [{ id: `${id}_a`, text: 'A' }, { id: `${id}_b`, text: 'B' }] } } });
    }
    try {
      const u = await make();
      const sessions = [await quiz.getRandomQuestions(u, subjectId, 4, 'SS1' as any), await quiz.getRandomQuestions(u, subjectId, 4, 'SS1' as any)];
      const outcomes = await Promise.allSettled(
        sessions.map((qs) => quiz.submitQuizResults(u, { sessionId: qs[0].sessionId, answers: qs.map((q) => ({ questionId: q.id, selectedOptionId: `${q.id}_a` })), timeTaken: 5 })),
      );
      expect(outcomes.filter((o) => o.status === 'rejected').map((o: any) => String(o.reason?.message).slice(0, 100))).toEqual([]);
      const stat = await prisma.subjectStat.findUniqueOrThrow({ where: { userId_subjectId: { userId: u, subjectId } } });
      expect(stat).toMatchObject({ questionsAnswered: 8, correctAnswers: 8 });
      expect((await prisma.dailyActivity.findFirstOrThrow({ where: { userId: u } })).questionsAnswered).toBe(8);
    } finally {
      await prisma.question.deleteMany({ where: { subjectId } });
      await prisma.subject.delete({ where: { id: subjectId } });
    }
  });

  it('copes with an empty notification-settings update arriving twice for a student who never opened settings', async () => {
    const notifications = new NotificationsService(prisma, { sendToUser: async () => undefined } as any);
    const u = await make();
    const results = await Promise.allSettled([notifications.updatePreferences(u, {}), notifications.updatePreferences(u, {}), notifications.updatePreferences(u, {})]);
    expect(results.filter((r) => r.status === 'rejected').map((r: any) => String(r.reason?.message).slice(0, 100))).toEqual([]);
    expect(await notifications.preferencesFor(u)).toEqual({ studyReminders: true, competitions: true, achievements: true, push: true });
  });
});
