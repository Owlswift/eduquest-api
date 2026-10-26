import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AttemptSource, ExamStatus, QuestionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { AchievementsService } from '../gamification/achievements.service';
import { AttemptsService } from '../progress/attempts.service';
import { ExamAnswerDto, StartExamDto } from './dto/exam.dto';

/** Seconds allowed per question when the caller does not pick a duration. */
export const EXAM_SECONDS_PER_QUESTION = 60;
/** Default length when the caller does not pick one. */
export const EXAM_DEFAULT_COUNT = 40;
/** Fewest questions an exam may have. */
export const EXAM_MIN_QUESTIONS = 5;
/** Network-lag allowance: answers arriving this long after the deadline still count. */
export const EXAM_GRACE_SECONDS = 30;

type Exam = NonNullable<Awaited<ReturnType<PrismaService['examSession']['findUnique']>>>;

@Injectable()
export class ExamsService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private attempts: AttemptsService,
    private achievements: AchievementsService,
  ) {}

  // ─── Start ──────────────────────────────────────────────────────────────────

  async start(userId: string, dto: StartExamDto) {
    // Settle any exam whose time ran out, so it neither blocks a new one nor
    // is lost without a result.
    const running = await this.prisma.examSession.findFirst({ where: { userId, status: ExamStatus.IN_PROGRESS } });
    if (running) {
      if (Date.now() > running.endsAt.getTime()) await this.finalize(running);
      else throw new ConflictException({ message: 'You already have an exam in progress', examId: running.id });
    }

    const subject = await this.prisma.subject.findUnique({ where: { id: dto.subjectId } });
    if (!subject) throw new NotFoundException(`Subject ${dto.subjectId} not found`);

    const count = dto.count ?? EXAM_DEFAULT_COUNT;
    const past = await this.prisma.question.findMany({
      where: { subjectId: dto.subjectId, examType: dto.examType, status: QuestionStatus.PUBLISHED },
      select: { id: true },
    });
    let pool = shuffle(past.map((q) => q.id));
    const pastOnly = past.length >= count;
    if (!pastOnly) {
      // Not enough past questions from this exam body: top up from the rest of the subject.
      const rest = await this.prisma.question.findMany({
        where: { subjectId: dto.subjectId, id: { notIn: pool }, status: QuestionStatus.PUBLISHED },
        select: { id: true },
      });
      pool = [...pool, ...shuffle(rest.map((q) => q.id))];
    }
    const questionIds = pool.slice(0, count);
    if (questionIds.length < EXAM_MIN_QUESTIONS) {
      throw new BadRequestException('There are not enough questions in this subject for an exam yet');
    }

    const durationSec = (dto.durationMinutes ?? Math.ceil((questionIds.length * EXAM_SECONDS_PER_QUESTION) / 60)) * 60;
    const startedAt = new Date();
    const exam = await this.prisma.examSession.create({
      data: {
        userId,
        examType: dto.examType,
        subjectId: dto.subjectId,
        questionIds,
        durationSec,
        startedAt,
        endsAt: new Date(startedAt.getTime() + durationSec * 1000),
        pastQuestionsOnly: pastOnly,
      },
    });
    return this.resumePayload(exam);
  }

  // ─── Read: resume, or the result once it is over ────────────────────────────

  async get(userId: string, examId: string) {
    let exam = await this.owned(userId, examId);
    if (exam.status === ExamStatus.IN_PROGRESS && Date.now() > exam.endsAt.getTime()) {
      exam = await this.finalize(exam); // time ran out while the app was closed
    }
    if (exam.status === ExamStatus.IN_PROGRESS) return this.resumePayload(exam);
    return this.result(await this.ensureGraded(exam));
  }

  private async resumePayload(exam: Exam) {
    const rows = await this.prisma.question.findMany({
      where: { id: { in: exam.questionIds } },
      include: { options: true },
    });
    const byId = new Map(rows.map((q) => [q.id, q]));
    return {
      status: 'IN_PROGRESS' as const,
      examId: exam.id,
      examType: exam.examType,
      subjectId: exam.subjectId,
      startedAt: exam.startedAt,
      endsAt: exam.endsAt,
      durationSec: exam.durationSec,
      remainingSec: Math.max(0, Math.round((exam.endsAt.getTime() - Date.now()) / 1000)),
      pastQuestionsOnly: exam.pastQuestionsOnly,
      savedAnswers: exam.answers as Record<string, string>,
      // Correct answers and explanations are withheld until the exam is over.
      questions: exam.questionIds
        .map((id) => byId.get(id))
        .filter((q): q is NonNullable<typeof q> => !!q)
        .map((q) => ({
          id: q.id,
          topic: q.topic,
          questionText: q.questionText,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
        })),
    };
  }

  // ─── Autosave ───────────────────────────────────────────────────────────────

  /** Merges answers into the saved set. Refused once the deadline (plus grace)
   *  has passed, so nothing can be added after time is up. */
  async saveAnswers(userId: string, examId: string, answers: ExamAnswerDto[]) {
    const exam = await this.owned(userId, examId);
    if (exam.status !== ExamStatus.IN_PROGRESS) throw new BadRequestException('This exam is already finished');
    const clean = this.clean(exam, answers);
    const saved = await this.mergeIfOpen(exam.id, userId, clean);
    if (!saved) {
      await this.finalize(exam); // out of time: close it now
      throw new BadRequestException('Time is up. Your saved answers have been submitted');
    }
    return { saved: Object.keys(clean).length, remainingSec: Math.max(0, Math.round((exam.endsAt.getTime() - Date.now()) / 1000)) };
  }

  // ─── Submit ─────────────────────────────────────────────────────────────────

  /** Idempotent: submitting twice returns the same result. Final answers sent
   *  with the request only count while the deadline (plus grace) is open. */
  async submit(userId: string, examId: string, answers: ExamAnswerDto[] = []) {
    const exam = await this.owned(userId, examId);
    if (exam.status === ExamStatus.SUBMITTED) return this.result(await this.ensureGraded(exam));
    if (answers.length > 0) await this.mergeIfOpen(exam.id, userId, this.clean(exam, answers)); // no-op when late
    return this.result(await this.finalize(exam));
  }

  // ─── History and review ─────────────────────────────────────────────────────

  async history(userId: string, limit = 20) {
    const overdue = await this.prisma.examSession.findMany({
      where: { userId, status: ExamStatus.IN_PROGRESS, endsAt: { lt: new Date() } },
    });
    for (const e of overdue) await this.finalize(e);

    const rows = await this.prisma.examSession.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((e) => ({
      examId: e.id,
      examType: e.examType,
      subjectId: e.subjectId,
      status: e.status,
      startedAt: e.startedAt,
      score: e.score,
      total: e.questionIds.length,
      percentage: e.score === null ? null : Math.round((e.score / e.questionIds.length) * 100),
      durationUsedSec: e.submittedAt ? Math.round((e.submittedAt.getTime() - e.startedAt.getTime()) / 1000) : null,
    }));
  }

  /** Every question with the student's answer, the right one and the
   *  explanation. Only after the exam is over. */
  async review(userId: string, examId: string) {
    let exam = await this.owned(userId, examId);
    if (exam.status === ExamStatus.IN_PROGRESS && Date.now() > exam.endsAt.getTime()) exam = await this.finalize(exam);
    if (exam.status !== ExamStatus.SUBMITTED) throw new BadRequestException('Answers are shown once the exam is finished');
    exam = await this.ensureGraded(exam);

    const rows = await this.prisma.question.findMany({
      where: { id: { in: exam.questionIds } },
      include: { options: true },
    });
    const byId = new Map(rows.map((q) => [q.id, q]));
    const saved = exam.answers as Record<string, string>;
    return {
      ...(await this.result(exam)),
      items: exam.questionIds
        .map((id) => byId.get(id))
        .filter((q): q is NonNullable<typeof q> => !!q)
        .map((q) => ({
          questionId: q.id,
          topic: q.topic,
          questionText: q.questionText,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
          selectedOptionId: saved[q.id] ?? null,
          correctOptionId: q.correctAnswerId,
          correct: saved[q.id] === q.correctAnswerId,
          explanation: q.explanation,
        })),
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async owned(userId: string, examId: string): Promise<Exam> {
    const exam = await this.prisma.examSession.findFirst({ where: { id: examId, userId } });
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  /** Only this exam's questions, one answer each, string values only. */
  private clean(exam: Exam, answers: ExamAnswerDto[]): Record<string, string> {
    const allowed = new Set(exam.questionIds);
    const out: Record<string, string> = {};
    for (const a of answers) if (allowed.has(a.questionId)) out[a.questionId] = a.selectedOptionId;
    return out;
  }

  /** Merge into `answers` only while the deadline (plus grace) is open, judged
   *  by the database clock. Resolves to whether anything was written. */
  private async mergeIfOpen(examId: string, userId: string, answers: Record<string, string>): Promise<boolean> {
    if (Object.keys(answers).length === 0) {
      const open = await this.prisma.$queryRaw<{ ok: boolean }[]>`
        SELECT (now() <= "endsAt" + make_interval(secs => ${EXAM_GRACE_SECONDS}::double precision)) AS ok FROM "ExamSession"
         WHERE "id" = ${examId} AND "userId" = ${userId} AND "status" = 'IN_PROGRESS'::"ExamStatus"`;
      return !!open[0]?.ok;
    }
    const written = await this.prisma.$executeRaw`
      UPDATE "ExamSession"
         SET "answers" = "answers" || ${JSON.stringify(answers)}::jsonb
       WHERE "id" = ${examId} AND "userId" = ${userId}
         AND "status" = 'IN_PROGRESS'::"ExamStatus"
         AND now() <= "endsAt" + make_interval(secs => ${EXAM_GRACE_SECONDS}::double precision)`;
    return written === 1;
  }

  /** Closes the exam exactly once (conditional UPDATE), then grades it. A
   *  second caller loses the race and gets the finished row. */
  private async finalize(exam: Exam): Promise<Exam> {
    const closed = await this.prisma.examSession.updateMany({
      where: { id: exam.id, status: ExamStatus.IN_PROGRESS },
      data: { status: ExamStatus.SUBMITTED, submittedAt: new Date() },
    });
    const fresh = await this.prisma.examSession.findUniqueOrThrow({ where: { id: exam.id } });
    return closed.count === 1 ? this.grade(fresh) : this.ensureGraded(fresh);
  }

  private async ensureGraded(exam: Exam): Promise<Exam> {
    return exam.score === null && exam.status === ExamStatus.SUBMITTED ? this.grade(exam) : exam;
  }

  /** Grades from the saved answers, records the history and study activity. */
  private async grade(exam: Exam): Promise<Exam> {
    const questions = await this.prisma.question.findMany({
      where: { id: { in: exam.questionIds } },
      select: { id: true, correctAnswerId: true },
    });
    const correctById = new Map(questions.map((q) => [q.id, q.correctAnswerId]));
    const saved = exam.answers as Record<string, string>;
    const rows = exam.questionIds.map((id) => {
      const chosen = saved[id];
      return { questionId: id, selectedOptionId: chosen ? chosen : null, correct: !!chosen && correctById.get(id) === chosen };
    });
    const score = rows.filter((r) => r.correct).length;

    // `score: null` guard: only the first grader writes and counts the activity.
    const wrote = await this.prisma.examSession.updateMany({ where: { id: exam.id, score: null }, data: { score } });
    if (wrote.count === 1) {
      await this.attempts.record(exam.userId, AttemptSource.EXAM, exam.id, rows);
      await this.prisma.user.update({ where: { id: exam.userId }, data: { questionsAnswered: { increment: exam.questionIds.length } } });
      await this.prisma.subjectStat.upsert({
        where: { userId_subjectId: { userId: exam.userId, subjectId: exam.subjectId } },
        create: { userId: exam.userId, subjectId: exam.subjectId, questionsAnswered: exam.questionIds.length, correctAnswers: score },
        update: { questionsAnswered: { increment: exam.questionIds.length }, correctAnswers: { increment: score }, lastActiveAt: new Date() },
      });
      // Counts toward the daily goal and streak. Exams pay no XP or coins.
      await this.activity.recordQuestions(exam.userId, exam.questionIds.length);
      await this.achievements.evaluate(exam.userId);
    }
    return this.prisma.examSession.findUniqueOrThrow({ where: { id: exam.id } });
  }

  private async resultByTopic(exam: Exam) {
    const rows = await this.prisma.questionAttempt.findMany({
      where: { userId: exam.userId, source: AttemptSource.EXAM, sourceRefId: exam.id },
      select: { topic: true, correct: true },
    });
    const by = new Map<string, { topic: string | null; total: number; correct: number }>();
    for (const r of rows) {
      const k = r.topic ?? '';
      const row = by.get(k) ?? { topic: r.topic, total: 0, correct: 0 };
      row.total += 1;
      if (r.correct) row.correct += 1;
      by.set(k, row);
    }
    return [...by.values()].sort((a, b) => a.correct / a.total - b.correct / b.total);
  }

  private async result(exam: Exam) {
    const total = exam.questionIds.length;
    const score = exam.score ?? 0;
    return {
      status: 'SUBMITTED' as const,
      examId: exam.id,
      examType: exam.examType,
      subjectId: exam.subjectId,
      score,
      total,
      percentage: Math.round((score / total) * 100),
      answered: Object.keys(exam.answers as object).length,
      durationSec: exam.durationSec,
      durationUsedSec: exam.submittedAt ? Math.min(exam.durationSec, Math.round((exam.submittedAt.getTime() - exam.startedAt.getTime()) / 1000)) : null,
      pastQuestionsOnly: exam.pastQuestionsOnly,
      byTopic: await this.resultByTopic(exam),
    };
  }
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
