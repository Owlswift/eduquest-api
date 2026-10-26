import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClassLevel, ExamType, Prisma, QuestionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from './audit.service';
import { CreateQuestionDto, OptionInputDto, UpdateQuestionDto } from './dto/question.dto';

/** Answers needed before a question's accuracy says anything. */
export const QUALITY_MIN_ATTEMPTS = 20;

export interface QuestionFilters {
  subjectId?: string;
  classLevel?: ClassLevel;
  topic?: string;
  status?: QuestionStatus;
  examType?: ExamType;
  q?: string;
  page: number;
  pageSize: number;
}

type QuestionWithOptions = Prisma.QuestionGetPayload<{ include: { options: true } }>;

@Injectable()
export class AdminQuestionsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ─── Read ───────────────────────────────────────────────────────────────────

  async list(f: QuestionFilters) {
    const where: Prisma.QuestionWhereInput = {
      ...(f.subjectId && { subjectId: f.subjectId }),
      ...(f.classLevel && { classLevel: f.classLevel }),
      ...(f.topic && { topic: f.topic }),
      ...(f.status && { status: f.status }),
      ...(f.examType && { examType: f.examType }),
      ...(f.q && { questionText: { contains: f.q, mode: 'insensitive' } }),
    };
    const pageSize = Math.min(Math.max(f.pageSize, 1), 100);
    const page = Math.max(f.page, 1);
    const [total, rows] = await Promise.all([
      this.prisma.question.count({ where }),
      this.prisma.question.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { options: true },
      }),
    ]);
    const stats = await this.performance(rows.map((r) => r.id));
    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => this.view(r, stats.get(r.id))),
    };
  }

  async get(id: string) {
    const q = await this.prisma.question.findUnique({ where: { id }, include: { options: true } });
    if (!q) throw new NotFoundException('Question not found');
    const stats = await this.performance([id]);
    return { ...this.view(q, stats.get(id)), history: await this.audit.history('question', id) };
  }

  /** How students actually do on each question: the basis for the quality flag. */
  private async performance(ids: string[]) {
    const out = new Map<string, { attempts: number; correct: number }>();
    if (ids.length === 0) return out;
    const [all, right] = await Promise.all([
      this.prisma.questionAttempt.groupBy({ by: ['questionId'], where: { questionId: { in: ids } }, _count: { _all: true } }),
      this.prisma.questionAttempt.groupBy({ by: ['questionId'], where: { questionId: { in: ids }, correct: true }, _count: { _all: true } }),
    ]);
    for (const a of all) out.set(a.questionId, { attempts: a._count._all, correct: 0 });
    for (const r of right) out.get(r.questionId)!.correct = r._count._all;
    return out;
  }

  private view(q: QuestionWithOptions, perf?: { attempts: number; correct: number }) {
    const attempts = perf?.attempts ?? 0;
    const correctRate = attempts ? (perf!.correct / attempts) : null;
    // Very low accuracy often means a wrong key or an ambiguous question; very
    // high means it teaches nothing. Both deserve a human look.
    const flag =
      attempts >= QUALITY_MIN_ATTEMPTS && correctRate !== null
        ? correctRate < 0.15 ? 'CHECK_ANSWER_KEY' : correctRate > 0.97 ? 'TOO_EASY' : null
        : null;
    return {
      id: q.id,
      subjectId: q.subjectId,
      classLevel: q.classLevel,
      topic: q.topic,
      questionText: q.questionText,
      explanation: q.explanation,
      difficulty: q.difficulty,
      examType: q.examType,
      examYear: q.examYear,
      status: q.status,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      options: q.options.map((o) => ({ id: o.id, text: o.text, correct: o.id === q.correctAnswerId })),
      attempts,
      correctRate,
      qualityFlag: flag as 'CHECK_ANSWER_KEY' | 'TOO_EASY' | null,
    };
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  async create(adminId: string, dto: CreateQuestionDto) {
    await this.assertSubject(dto.subjectId);
    const options = this.normaliseOptions(dto.options, dto.correctIndex);
    const status = dto.status ?? QuestionStatus.DRAFT;

    const created = await this.prisma.question.create({
      data: {
        subjectId: dto.subjectId,
        classLevel: dto.classLevel,
        topic: dto.topic?.trim() || null,
        questionText: dto.questionText.trim(),
        explanation: dto.explanation?.trim() || null,
        difficulty: dto.difficulty ?? 1,
        examType: dto.examType ?? null,
        examYear: dto.examYear ?? null,
        status,
        correctAnswerId: options.options[dto.correctIndex].id,
        options: { create: options.options.map((o) => ({ id: o.id, text: o.text })) },
      },
      include: { options: true },
    });
    await this.audit.log({
      adminId,
      action: 'question.create',
      entityType: 'question',
      entityId: created.id,
      summary: `Created ${status.toLowerCase()} question in ${dto.subjectId} (${dto.classLevel})`,
      after: this.snapshot(created),
    });
    return this.get(created.id);
  }

  async update(adminId: string, id: string, dto: UpdateQuestionDto) {
    const before = await this.prisma.question.findUnique({ where: { id }, include: { options: true } });
    if (!before) throw new NotFoundException('Question not found');
    if (dto.subjectId) await this.assertSubject(dto.subjectId);
    if ((dto.options === undefined) !== (dto.correctIndex === undefined)) {
      throw new BadRequestException('Send options and correctIndex together');
    }

    const data: Prisma.QuestionUpdateInput = {};
    if (dto.subjectId !== undefined) data.subject = { connect: { id: dto.subjectId } };
    if (dto.classLevel !== undefined) data.classLevel = dto.classLevel;
    if (dto.topic !== undefined) data.topic = dto.topic?.trim() || null;
    if (dto.questionText !== undefined) data.questionText = dto.questionText.trim();
    if (dto.explanation !== undefined) data.explanation = dto.explanation?.trim() || null;
    if (dto.difficulty !== undefined) data.difficulty = dto.difficulty;
    if (dto.examType !== undefined) data.examType = dto.examType;
    if (dto.examYear !== undefined) data.examYear = dto.examYear;

    const after = await this.prisma.$transaction(async (tx) => {
      if (dto.options && dto.correctIndex !== undefined) {
        const next = this.normaliseOptions(dto.options, dto.correctIndex, before.options.map((o) => o.id));
        const keep = new Set(next.options.map((o) => o.id));
        await tx.answerOption.deleteMany({ where: { questionId: id, id: { notIn: [...keep] } } });
        for (const o of next.options) {
          await tx.answerOption.upsert({
            where: { id: o.id },
            create: { id: o.id, text: o.text, questionId: id },
            update: { text: o.text },
          });
        }
        data.correctAnswerId = next.options[dto.correctIndex].id;
      }
      // A question that is live must stay answerable.
      return tx.question.update({ where: { id }, data, include: { options: true } });
    });

    const answerChanged = before.correctAnswerId !== after.correctAnswerId;
    await this.audit.log({
      adminId,
      action: 'question.update',
      entityType: 'question',
      entityId: id,
      summary: answerChanged ? 'Edited question and CHANGED the correct answer' : 'Edited question',
      before: this.snapshot(before),
      after: this.snapshot(after),
    });
    return this.get(id);
  }

  async setStatus(adminId: string, id: string, status: QuestionStatus) {
    const q = await this.prisma.question.findUnique({ where: { id }, include: { options: true } });
    if (!q) throw new NotFoundException('Question not found');
    if (q.status === status) return this.get(id);
    if (status === QuestionStatus.PUBLISHED) this.assertPublishable(q);

    await this.prisma.question.update({ where: { id }, data: { status } });
    await this.audit.log({
      adminId,
      action: `question.${status.toLowerCase()}`,
      entityType: 'question',
      entityId: id,
      summary: `${q.status} to ${status}`,
      before: { status: q.status },
      after: { status },
    });
    return this.get(id);
  }

  /** Only a draft nobody has answered can be deleted; anything else is retired so history stays valid. */
  async remove(adminId: string, id: string) {
    const q = await this.prisma.question.findUnique({ where: { id }, include: { options: true } });
    if (!q) throw new NotFoundException('Question not found');
    const attempts = await this.prisma.questionAttempt.count({ where: { questionId: id } });
    if (q.status !== QuestionStatus.DRAFT || attempts > 0) {
      throw new ConflictException('Only an unused draft can be deleted. Retire this question instead');
    }
    await this.prisma.question.delete({ where: { id } });
    await this.audit.log({
      adminId,
      action: 'question.delete',
      entityType: 'question',
      entityId: id,
      summary: 'Deleted unused draft',
      before: this.snapshot(q),
    });
    return { deleted: true };
  }

  // ─── Rules ──────────────────────────────────────────────────────────────────

  private async assertSubject(subjectId: string) {
    const s = await this.prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true } });
    if (!s) throw new BadRequestException(`Unknown subject ${subjectId}`);
  }

  /** Trim, reject blanks and duplicates, keep or mint ids, and check the answer index. */
  private normaliseOptions(options: OptionInputDto[], correctIndex: number, existingIds: string[] = []) {
    const cleaned = options.map((o) => ({ id: o.id, text: o.text.trim() }));
    if (cleaned.some((o) => o.text.length === 0)) throw new BadRequestException('Options cannot be blank');
    const texts = cleaned.map((o) => o.text.toLowerCase());
    if (new Set(texts).size !== texts.length) throw new BadRequestException('Two options have the same text');
    if (correctIndex < 0 || correctIndex >= cleaned.length) {
      throw new BadRequestException('correctIndex must point at one of the options');
    }
    const known = new Set(existingIds);
    for (const o of cleaned) {
      if (o.id && !known.has(o.id)) throw new BadRequestException(`Option ${o.id} does not belong to this question`);
    }
    const ids = cleaned.map((o) => o.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('The same option was sent twice');
    return { options: cleaned.map((o) => ({ id: o.id ?? randomUUID(), text: o.text })) };
  }

  private assertPublishable(q: QuestionWithOptions) {
    if (q.options.length < 2) throw new BadRequestException('A question needs at least two options to be published');
    if (!q.options.some((o) => o.id === q.correctAnswerId)) {
      throw new BadRequestException('The correct answer is not one of the options');
    }
    if (q.questionText.trim().length < 5) throw new BadRequestException('The question text is too short');
  }

  private snapshot(q: QuestionWithOptions): Prisma.InputJsonValue {
    return {
      subjectId: q.subjectId,
      classLevel: q.classLevel,
      topic: q.topic,
      questionText: q.questionText,
      explanation: q.explanation,
      difficulty: q.difficulty,
      examType: q.examType,
      examYear: q.examYear,
      status: q.status,
      correctAnswerId: q.correctAnswerId,
      options: q.options.map((o) => ({ id: o.id, text: o.text })),
    };
  }
}
