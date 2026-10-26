import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from './audit.service';
import { CreateCompetitionDto, UpdateCompetitionDto } from './dto/competition.dto';

type Status = 'upcoming' | 'ongoing' | 'ended';

@Injectable()
export class AdminCompetitionsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private status(c: { startsAt: Date; endsAt: Date }, now = new Date()): Status {
    if (now < c.startsAt) return 'upcoming';
    if (now > c.endsAt) return 'ended';
    return 'ongoing';
  }

  private view(c: { id: string; title: string; subtitle: string; prizes: unknown; startsAt: Date; endsAt: Date; createdAt: Date }, participants: number) {
    return {
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      prizes: c.prizes as string[],
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      createdAt: c.createdAt,
      status: this.status(c),
      participants,
      // Rules are fixed once a competition starts (PRODUCT.md section 6.3).
      datesLocked: this.status(c) !== 'upcoming',
    };
  }

  async list() {
    const rows = await this.prisma.competition.findMany({
      orderBy: { startsAt: 'desc' },
      include: { _count: { select: { participants: true } } },
    });
    return rows.map((c) => this.view(c, c._count.participants));
  }

  async get(id: string) {
    const c = await this.prisma.competition.findUnique({
      where: { id },
      include: { _count: { select: { participants: true } } },
    });
    if (!c) throw new NotFoundException('Competition not found');
    return { ...this.view(c, c._count.participants), history: await this.audit.history('competition', id) };
  }

  async create(adminId: string, dto: CreateCompetitionDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    this.assertWindow(startsAt, endsAt);
    if (endsAt <= new Date()) throw new BadRequestException('The end date must be in the future');

    const c = await this.prisma.competition.create({
      data: { title: dto.title.trim(), subtitle: dto.subtitle.trim(), prizes: dto.prizes.map((p) => p.trim()), startsAt, endsAt },
    });
    await this.audit.log({
      adminId,
      action: 'competition.create',
      entityType: 'competition',
      entityId: c.id,
      summary: `Created "${c.title}"`,
      after: { title: c.title, prizes: dto.prizes, startsAt: dto.startsAt, endsAt: dto.endsAt },
    });
    return this.get(c.id);
  }

  async update(adminId: string, id: string, dto: UpdateCompetitionDto) {
    const before = await this.prisma.competition.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Competition not found');

    const changingDates = dto.startsAt !== undefined || dto.endsAt !== undefined;
    if (changingDates && this.status(before) !== 'upcoming') {
      throw new ConflictException('Dates are locked once a competition has started. Edit the title, subtitle or prizes instead');
    }
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : before.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : before.endsAt;
    if (changingDates) this.assertWindow(startsAt, endsAt);

    const after = await this.prisma.competition.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title.trim() }),
        ...(dto.subtitle !== undefined && { subtitle: dto.subtitle.trim() }),
        ...(dto.prizes !== undefined && { prizes: dto.prizes.map((p) => p.trim()) }),
        ...(changingDates && { startsAt, endsAt }),
      },
    });
    await this.audit.log({
      adminId,
      action: 'competition.update',
      entityType: 'competition',
      entityId: id,
      summary: `Edited "${after.title}"`,
      before: { title: before.title, subtitle: before.subtitle, prizes: before.prizes as string[], startsAt: before.startsAt.toISOString(), endsAt: before.endsAt.toISOString() },
      after: { title: after.title, subtitle: after.subtitle, prizes: after.prizes as string[], startsAt: after.startsAt.toISOString(), endsAt: after.endsAt.toISOString() },
    });
    return this.get(id);
  }

  /** Only a competition nobody joined can be removed. */
  async remove(adminId: string, id: string) {
    const c = await this.prisma.competition.findUnique({
      where: { id },
      include: { _count: { select: { participants: true } } },
    });
    if (!c) throw new NotFoundException('Competition not found');
    if (c._count.participants > 0) {
      throw new ConflictException(`${c._count.participants} students have joined. A competition with entries cannot be deleted`);
    }
    await this.prisma.competition.delete({ where: { id } });
    await this.audit.log({
      adminId,
      action: 'competition.delete',
      entityType: 'competition',
      entityId: id,
      summary: `Deleted "${c.title}" (no entries)`,
      before: { title: c.title, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString() },
    });
    return { deleted: true };
  }

  private assertWindow(startsAt: Date, endsAt: Date) {
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new BadRequestException('Invalid date');
    if (endsAt <= startsAt) throw new BadRequestException('The end date must be after the start date');
  }
}
