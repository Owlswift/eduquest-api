import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CompetitionStatus, Prisma, QuestionStatus } from '@prisma/client';
import { REGION_LABEL } from '../../common/geo/regions';
import { PrismaService } from '../../database/prisma.service';
import { effectiveStatus, prizeRangeProblems, StageRule, stageLinkProblems } from '../competitions/competition-rules';
import { publicSponsor, SPONSOR_SELECT } from '../sponsors/logo';
import { AuditService } from './audit.service';
import { CreateCompetitionDto, PrizeInputDto, UpdateCompetitionDto } from './dto/competition.dto';

const INCLUDE = {
  prizeList: { orderBy: { sortOrder: 'asc' } },
  nextStage: { select: { id: true, title: true } },
  sponsor: { select: SPONSOR_SELECT },
  _count: { select: { participants: true, qualifications: true } },
} as const;

type Full = Prisma.CompetitionGetPayload<{ include: typeof INCLUDE }>;

/** Window after the planned start in which a draft can still be published. */
const PUBLISH_LATE_TOLERANCE_MS = 5 * 60_000;

@Injectable()
export class AdminCompetitionsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ─── Read ───────────────────────────────────────────────────────────────────

  async list() {
    const rows = await this.prisma.competition.findMany({ orderBy: { startsAt: 'desc' }, include: INCLUDE });
    await this.sync(rows);
    return rows.map((c) => this.view(c));
  }

  async get(id: string) {
    const c = await this.load(id);
    const completed = await this.prisma.competitionParticipant.count({ where: { competitionId: id, status: 'COMPLETED' } });
    return { ...this.view(c), completed, history: await this.audit.history('competition', id) };
  }

  private async load(id: string): Promise<Full> {
    const c = await this.prisma.competition.findUnique({ where: { id }, include: INCLUDE });
    if (!c) throw new NotFoundException('Competition not found');
    await this.sync([c]);
    return c;
  }

  /** Keep stored statuses in step with the clock, as the student API does. */
  private async sync(rows: { id: string; status: CompetitionStatus; startsAt: Date; endsAt: Date }[]) {
    const now = new Date();
    for (const r of rows) {
      const next = effectiveStatus(r, now);
      if (next === r.status) continue;
      await this.prisma.competition.updateMany({ where: { id: r.id, status: r.status }, data: { status: next } });
      r.status = next;
    }
  }

  private view(c: Full) {
    return {
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      description: c.description,
      type: c.type,
      format: c.format,
      status: c.status,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      createdAt: c.createdAt,
      classLevels: c.classLevels,
      subjectIds: c.subjectIds,
      state: c.state,
      region: c.region,
      questionCount: c.questionCount,
      pointsPerQuiz: c.pointsPerQuiz,
      dailyPointsCap: c.dailyPointsCap,
      minQuestionsPerQuiz: c.minQuestionsPerQuiz,
      questionsFrozen: c.questionIds.length > 0,
      pointsPerCorrect: c.pointsPerCorrect,
      penaltyPerWrong: c.penaltyPerWrong,
      timeLimitSec: c.timeLimitSec,
      participationXp: c.participationXp,
      participationCoins: c.participationCoins,
      claimDeadlineDays: c.claimDeadlineDays,
      participants: c._count.participants,
      // Stages: where this one leads, and who it has qualified for itself.
      sponsor: publicSponsor(c.sponsor),
      requiresQualification: c.requiresQualification,
      nextStage: c.nextStage,
      advanceCount: c.advanceCount,
      qualified: c._count.qualifications,
      prizes: c.prizeList.map((p) => ({ id: p.id, positionFrom: p.positionFrom, positionTo: p.positionTo, title: p.title, kind: p.kind, coinAmount: p.coinAmount })),
      // What an admin can still change at this stage (see update()).
      editable: this.editable(c),
      publishedAt: c.publishedAt,
      finalisedAt: c.finalisedAt,
    };
  }

  private editable(c: Pick<Full, 'status' | 'format'>): 'all' | 'schedule_and_prizes' | 'wording' | 'none' {
    if (c.format === 'XP_WINDOW') return c.status === 'PUBLISHED' ? 'schedule_and_prizes' : c.status === 'ACTIVE' ? 'wording' : 'none';
    if (c.status === 'DRAFT') return 'all';
    if (c.status === 'PUBLISHED') return 'schedule_and_prizes';
    if (c.status === 'ACTIVE') return 'wording';
    return 'none';
  }

  /** The students an earlier stage has qualified for this competition. */
  async qualifiers(id: string) {
    await this.load(id);
    const rows = await this.prisma.competitionQualification.findMany({
      where: { competitionId: id },
      orderBy: [{ fromCompetitionId: 'asc' }, { fromRank: 'asc' }],
      include: { user: { select: { fullName: true, email: true, state: true, classLevel: true } }, fromCompetition: { select: { title: true } } },
    });
    return rows.map((q) => ({
      userId: q.userId,
      fullName: q.user.fullName,
      email: q.user.email,
      state: q.user.state,
      classLevel: q.user.classLevel,
      fromCompetition: { id: q.fromCompetitionId, title: q.fromCompetition.title },
      fromRank: q.fromRank,
      qualifiedAt: q.createdAt,
    }));
  }

  // ─── Create / update ────────────────────────────────────────────────────────

  async create(adminId: string, dto: CreateCompetitionDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    this.assertWindow(startsAt, endsAt);
    this.assertScope(dto.type, dto.state, dto.region);
    const format = dto.format ?? 'FIXED_SET';
    this.assertScoring(format, dto);
    const prizes = this.checkedPrizes(dto.prizes ?? []);
    if (dto.timeLimitMinutes && dto.timeLimitMinutes * 60_000 > endsAt.getTime() - startsAt.getTime()) {
      throw new BadRequestException('The time limit is longer than the competition itself');
    }
    await this.assertSubjects(dto.subjectIds ?? []);
    if (dto.sponsorId) await this.assertSponsor(dto.sponsorId);
    if (dto.nextStageId) await this.assertStageLink({ id: 'new', status: 'DRAFT', startsAt, endsAt, nextStageId: dto.nextStageId, requiresQualification: !!dto.requiresQualification }, dto.nextStageId, dto.advanceCount);
    else if (dto.advanceCount) throw new BadRequestException('advanceCount only applies when there is a next stage');

    const c = await this.prisma.competition.create({
      data: {
        title: dto.title.trim(),
        subtitle: dto.subtitle.trim(),
        description: dto.description?.trim() || null,
        prizes: prizes.map((p) => p.title),
        startsAt,
        endsAt,
        type: dto.type,
        format,
        status: 'DRAFT',
        classLevels: dto.classLevels ?? [],
        subjectIds: dto.subjectIds ?? [],
        state: dto.type === 'STATE' ? dto.state! : null,
        region: dto.type === 'REGIONAL' ? dto.region! : null,
        questionCount: format === 'FIXED_SET' ? dto.questionCount : null,
        pointsPerQuiz: format === 'POINTS_LEAGUE' ? dto.pointsPerQuiz : null,
        dailyPointsCap: format === 'POINTS_LEAGUE' ? (dto.dailyPointsCap ?? null) : null,
        minQuestionsPerQuiz: dto.minQuestionsPerQuiz ?? 5,
        pointsPerCorrect: dto.pointsPerCorrect ?? 1,
        penaltyPerWrong: dto.penaltyPerWrong ?? 0,
        timeLimitSec: dto.timeLimitMinutes ? dto.timeLimitMinutes * 60 : null,
        participationXp: dto.participationXp ?? 0,
        participationCoins: dto.participationCoins ?? 0,
        claimDeadlineDays: dto.claimDeadlineDays ?? 14,
        sponsorId: dto.sponsorId ?? null,
        requiresQualification: dto.requiresQualification ?? false,
        nextStageId: dto.nextStageId ?? null,
        advanceCount: dto.nextStageId ? dto.advanceCount : null,
        prizeList: { create: prizes.map((p, i) => this.prizeData(p, i)) },
      },
      include: INCLUDE,
    });
    await this.audit.log({
      adminId,
      action: 'competition.create',
      entityType: 'competition',
      entityId: c.id,
      summary: `Created draft "${c.title}" (${c.type})`,
      after: this.snapshot(c),
    });
    return this.get(c.id);
  }

  async update(adminId: string, id: string, dto: UpdateCompetitionDto) {
    const before = await this.load(id);
    const level = this.editable(before);
    if (level === 'none') throw new ConflictException('This competition is finished and can no longer be edited');

    const touched = Object.entries(dto).filter(([, v]) => v !== undefined).map(([k]) => k);
    const allowed: Record<string, string[]> = {
      wording: ['title', 'subtitle', 'description'],
      // Where the top finishers go next does not change how this one is played, so it can still be set.
      schedule_and_prizes: ['title', 'subtitle', 'description', 'startsAt', 'endsAt', 'prizes', 'claimDeadlineDays', 'nextStageId', 'advanceCount', 'sponsorId'],
    };
    if (level !== 'all') {
      const forbidden = touched.filter((k) => !allowed[level].includes(k));
      if (forbidden.length > 0) {
        throw new ConflictException(
          `${forbidden.join(', ')} cannot change at this stage: the rules are fixed once a competition is published. Only ${allowed[level].join(', ')} can.`,
        );
      }
    }

    const startsAt = dto.startsAt ? new Date(dto.startsAt) : before.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : before.endsAt;
    if (dto.startsAt || dto.endsAt) this.assertWindow(startsAt, endsAt);
    const type = dto.type ?? before.type;
    const state = dto.state !== undefined ? dto.state : before.state;
    const region = dto.region !== undefined ? dto.region : before.region;
    if (dto.type || dto.state !== undefined || dto.region) this.assertScope(type, state ?? undefined, region ?? undefined);
    const prizes = dto.prizes ? this.checkedPrizes(dto.prizes) : null;
    if (dto.subjectIds) await this.assertSubjects(dto.subjectIds);
    if (dto.sponsorId) await this.assertSponsor(dto.sponsorId);
    const limitSec = dto.timeLimitMinutes ? dto.timeLimitMinutes * 60 : before.timeLimitSec;
    if (limitSec && limitSec * 1000 > endsAt.getTime() - startsAt.getTime()) {
      throw new BadRequestException('The time limit is longer than the competition itself');
    }

    if (before.format === 'POINTS_LEAGUE' && (dto.pointsPerQuiz !== undefined || dto.dailyPointsCap !== undefined)) {
      this.assertScoring('POINTS_LEAGUE', { pointsPerQuiz: dto.pointsPerQuiz ?? before.pointsPerQuiz ?? undefined, dailyPointsCap: dto.dailyPointsCap ?? before.dailyPointsCap ?? undefined });
    }
    // Stages: check the link as it will be, and the dates against both neighbours.
    const nextStageId = dto.nextStageId !== undefined ? dto.nextStageId : before.nextStageId;
    const advanceCount = nextStageId ? (dto.advanceCount !== undefined ? dto.advanceCount : before.advanceCount) : null;
    const requiresQualification = dto.requiresQualification ?? before.requiresQualification;
    if (!nextStageId && dto.advanceCount) throw new BadRequestException('advanceCount only applies when there is a next stage');
    if (nextStageId && (dto.nextStageId || dto.advanceCount !== undefined || dto.startsAt || dto.endsAt)) {
      await this.assertStageLink({ id, status: before.status, startsAt, endsAt, nextStageId, requiresQualification }, nextStageId, advanceCount);
    }
    if (dto.startsAt || dto.endsAt) await this.assertFeedersEndBefore(id, startsAt);

    const after = await this.prisma.$transaction(async (tx) => {
      if (prizes) {
        await tx.competitionPrize.deleteMany({ where: { competitionId: id } });
        await tx.competitionPrize.createMany({ data: prizes.map((p, i) => ({ competitionId: id, ...this.prizeData(p, i) })) });
      }
      return tx.competition.update({
        where: { id },
        data: {
          ...(dto.title !== undefined && { title: dto.title.trim() }),
          ...(dto.subtitle !== undefined && { subtitle: dto.subtitle.trim() }),
          ...(dto.description !== undefined && { description: dto.description.trim() || null }),
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.classLevels !== undefined && { classLevels: dto.classLevels }),
          ...(dto.subjectIds !== undefined && { subjectIds: dto.subjectIds }),
          ...((dto.type !== undefined || dto.state !== undefined) && { state: type === 'STATE' ? state : null }),
          ...((dto.type !== undefined || dto.region !== undefined) && { region: type === 'REGIONAL' ? region : null }),
          ...(dto.questionCount !== undefined && { questionCount: dto.questionCount }),
          ...(dto.pointsPerQuiz !== undefined && { pointsPerQuiz: dto.pointsPerQuiz }),
          ...(dto.dailyPointsCap !== undefined && { dailyPointsCap: dto.dailyPointsCap }),
          ...(dto.minQuestionsPerQuiz !== undefined && { minQuestionsPerQuiz: dto.minQuestionsPerQuiz }),
          ...(dto.pointsPerCorrect !== undefined && { pointsPerCorrect: dto.pointsPerCorrect }),
          ...(dto.penaltyPerWrong !== undefined && { penaltyPerWrong: dto.penaltyPerWrong }),
          ...(dto.timeLimitMinutes !== undefined && { timeLimitSec: dto.timeLimitMinutes * 60 }),
          ...(dto.participationXp !== undefined && { participationXp: dto.participationXp }),
          ...(dto.participationCoins !== undefined && { participationCoins: dto.participationCoins }),
          ...(dto.claimDeadlineDays !== undefined && { claimDeadlineDays: dto.claimDeadlineDays }),
          ...(dto.sponsorId !== undefined && { sponsorId: dto.sponsorId }),
          ...(dto.requiresQualification !== undefined && { requiresQualification: dto.requiresQualification }),
          ...((dto.nextStageId !== undefined || dto.advanceCount !== undefined) && { nextStageId: nextStageId ?? null, advanceCount }),
          ...(prizes && { prizes: prizes.map((p) => p.title) }),
          ...((dto.startsAt || dto.endsAt) && { startsAt, endsAt }),
        },
        include: INCLUDE,
      });
    });

    await this.audit.log({
      adminId,
      action: 'competition.update',
      entityType: 'competition',
      entityId: id,
      summary: `Edited "${after.title}" (${touched.join(', ')})`,
      before: this.snapshot(before),
      after: this.snapshot(after),
    });
    return this.get(id);
  }

  // ─── Publish / close / delete ───────────────────────────────────────────────

  /**
   * Freezes the rules. Picks the questions now (so every entrant gets the same
   * set) from published questions matching the class levels and subjects, and
   * from this point the scoring and eligibility cannot change.
   */
  async publish(adminId: string, id: string) {
    const c = await this.load(id);
    if (c.status !== 'DRAFT') throw new ConflictException('Only a draft can be published');
    if (c.format === 'POINTS_LEAGUE') {
      if (!c.pointsPerQuiz) throw new BadRequestException('Set how many points each quiz earns first');
    } else if (c.format !== 'FIXED_SET' || !c.questionCount) {
      throw new BadRequestException('Set how many questions the competition has first');
    }
    if (c.endsAt <= new Date()) throw new BadRequestException('The end date has passed. Edit the dates first');
    if (c.startsAt.getTime() < Date.now() - PUBLISH_LATE_TOLERANCE_MS) {
      throw new BadRequestException('The start date has passed. Edit the dates first');
    }
    if (c.type === 'STATE' && !c.state) throw new BadRequestException('A state competition needs a state');
    if (c.type === 'REGIONAL' && !c.region) throw new BadRequestException('A regional competition needs a region');

    // A league has no question set: students earn points from their own practice quizzes.
    if (c.format === 'POINTS_LEAGUE') {
      const flipped = await this.prisma.competition.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      if (flipped.count === 0) throw new ConflictException('This competition was just published by someone else');
      await this.audit.log({ adminId, action: 'competition.publish', entityType: 'competition', entityId: id, summary: `Published league "${c.title}" (${c.pointsPerQuiz} points per quiz)`, before: { status: 'DRAFT' }, after: { status: 'PUBLISHED' } });
      return this.get(id);
    }

    const pool = await this.prisma.question.findMany({
      where: {
        status: QuestionStatus.PUBLISHED,
        ...(c.classLevels.length > 0 && { classLevel: { in: c.classLevels } }),
        ...(c.subjectIds.length > 0 && { subjectId: { in: c.subjectIds } }),
      },
      select: { id: true },
    });
    const needed = c.questionCount ?? 0; // set: checked above
    if (pool.length < needed) {
      throw new BadRequestException(`Only ${pool.length} published questions match, but the competition needs ${needed}`);
    }
    const questionIds = shuffle(pool.map((q) => q.id)).slice(0, needed);

    const flipped = await this.prisma.competition.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'PUBLISHED', questionIds, publishedAt: new Date() },
    });
    if (flipped.count === 0) throw new ConflictException('This competition was just published by someone else');
    await this.audit.log({
      adminId,
      action: 'competition.publish',
      entityType: 'competition',
      entityId: id,
      summary: `Published "${c.title}" with ${questionIds.length} questions`,
      before: { status: 'DRAFT' },
      after: { status: 'PUBLISHED', questions: questionIds.length },
    });
    return this.get(id);
  }

  /** Ends a running competition now (for example if a question was found to be wrong). */
  async closeNow(adminId: string, id: string, reason: string) {
    const c = await this.load(id);
    if (c.status !== 'ACTIVE') throw new ConflictException('Only a running competition can be closed early');
    await this.prisma.competition.update({ where: { id }, data: { status: 'CLOSED', endsAt: new Date() } });
    await this.audit.log({
      adminId,
      action: 'competition.close',
      entityType: 'competition',
      entityId: id,
      summary: `Closed "${c.title}" early: ${reason}`,
      before: { status: c.status, endsAt: c.endsAt.toISOString() },
      after: { status: 'CLOSED' },
    });
    return this.get(id);
  }

  /** A draft can always go; anything published only while nobody has entered. */
  async remove(adminId: string, id: string) {
    const c = await this.load(id);
    if (c.status !== 'DRAFT' && c._count.participants > 0) {
      throw new ConflictException(`${c._count.participants} students have joined. A competition with entries cannot be deleted`);
    }
    if (c.status === 'FINALISED' || c.status === 'ARCHIVED') throw new ConflictException('Finished competitions are kept as a record');
    await this.prisma.competition.delete({ where: { id } });
    await this.audit.log({
      adminId,
      action: 'competition.delete',
      entityType: 'competition',
      entityId: id,
      summary: `Deleted "${c.title}" (${c.status.toLowerCase()}, no entries)`,
      before: this.snapshot(c),
    });
    return { deleted: true };
  }

  // ─── Rules ──────────────────────────────────────────────────────────────────

  private assertWindow(startsAt: Date, endsAt: Date) {
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new BadRequestException('Invalid date');
    if (endsAt <= startsAt) throw new BadRequestException('The end date must be after the start date');
  }

  /** Rules every stage link must satisfy; reads the other competitions so loops and bad dates are caught. */
  private async assertStageLink(from: StageRule, nextStageId: string, advanceCount: number | null | undefined) {
    const rows = await this.prisma.competition.findMany({ select: { id: true, status: true, startsAt: true, endsAt: true, nextStageId: true, requiresQualification: true } });
    const now = new Date();
    const all: StageRule[] = rows.map((r) => ({ ...r, status: effectiveStatus(r, now) }));
    const next = all.find((r) => r.id === nextStageId);
    if (!next) throw new BadRequestException('The next stage does not exist');
    const problems = stageLinkProblems(from, next, advanceCount, [...all.filter((r) => r.id !== from.id), from]);
    if (problems.length > 0) throw new BadRequestException(problems.join('. '));
  }

  /** A competition that qualifiers feed cannot start before they have all ended. */
  private async assertFeedersEndBefore(id: string, startsAt: Date) {
    const late = await this.prisma.competition.findFirst({ where: { nextStageId: id, endsAt: { gt: startsAt } }, select: { title: true } });
    if (late) throw new BadRequestException(`"${late.title}" feeds this competition and ends after the new start date`);
  }

  /** A fixed-set competition needs a question count; a league needs points per quiz and a sensible daily maximum. */
  private assertScoring(format: string, d: { questionCount?: number; pointsPerQuiz?: number; dailyPointsCap?: number; timeLimitMinutes?: number }) {
    if (format === 'POINTS_LEAGUE') {
      if (!d.pointsPerQuiz) throw new BadRequestException('A points league needs the points each quiz earns');
      if (d.dailyPointsCap != null && d.dailyPointsCap < d.pointsPerQuiz) throw new BadRequestException('The daily maximum must be at least the points of one quiz');
      if (d.timeLimitMinutes) throw new BadRequestException('A points league is not timed');
    } else if (!d.questionCount) {
      throw new BadRequestException('A fixed-set competition needs a question count');
    }
  }

  private assertScope(type: string, state?: string, region?: string) {
    if (type === 'STATE' && !state) throw new BadRequestException('A state competition needs a state');
    if (type === 'REGIONAL' && !region) throw new BadRequestException(`A regional competition needs a region (${Object.values(REGION_LABEL).join(', ')})`);
  }

  private checkedPrizes(prizes: PrizeInputDto[]): PrizeInputDto[] {
    const problems = prizeRangeProblems(prizes);
    for (const p of prizes) if (p.kind === 'COINS' && !p.coinAmount) problems.push(`"${p.title}" is a coin prize, so it needs an amount`);
    if (problems.length > 0) throw new BadRequestException(problems.join('. '));
    return [...prizes].sort((a, b) => a.positionFrom - b.positionFrom);
  }

  private prizeData(p: PrizeInputDto, i: number) {
    return { positionFrom: p.positionFrom, positionTo: p.positionTo, title: p.title.trim(), kind: p.kind, coinAmount: p.kind === 'COINS' ? (p.coinAmount ?? null) : null, sortOrder: i };
  }

  private async assertSponsor(id: string) {
    if (!(await this.prisma.sponsor.findUnique({ where: { id }, select: { id: true } }))) throw new BadRequestException('That sponsor does not exist');
  }

  private async assertSubjects(ids: string[]) {
    if (ids.length === 0) return;
    const known = await this.prisma.subject.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const unknown = ids.filter((id) => !known.some((k) => k.id === id));
    if (unknown.length > 0) throw new BadRequestException(`Unknown subject: ${unknown.join(', ')}`);
  }

  private snapshot(c: Full): Prisma.InputJsonValue {
    return {
      title: c.title,
      subtitle: c.subtitle,
      type: c.type,
      status: c.status,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      classLevels: c.classLevels,
      subjectIds: c.subjectIds,
      state: c.state,
      region: c.region,
      questionCount: c.questionCount,
      pointsPerCorrect: c.pointsPerCorrect,
      penaltyPerWrong: c.penaltyPerWrong,
      timeLimitSec: c.timeLimitSec,
      prizes: c.prizeList.map((p) => `${p.positionFrom}-${p.positionTo}: ${p.title}`),
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
