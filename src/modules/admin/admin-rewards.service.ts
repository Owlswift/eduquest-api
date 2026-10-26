import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from './audit.service';
import { CreateRewardDto, UpdateRewardDto } from './dto/reward.dto';

type Reward = Prisma.RewardGetPayload<object>;

@Injectable()
export class AdminRewardsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Every reward, including inactive ones, with how many redemptions it has had. */
  async list() {
    const [rewards, counts] = await Promise.all([
      this.prisma.reward.findMany({ orderBy: [{ sortOrder: 'asc' }, { coinCost: 'asc' }] }),
      this.prisma.rewardRedemption.groupBy({ by: ['rewardId', 'status'], _count: { _all: true } }),
    ]);
    return rewards.map((r) => {
      const mine = counts.filter((c) => c.rewardId === r.id);
      const total = (statuses?: string[]) => mine.filter((c) => !statuses || statuses.includes(c.status)).reduce((n, c) => n + c._count._all, 0);
      return { ...this.view(r), redemptions: total(), openRedemptions: total(['PENDING', 'APPROVED']) };
    });
  }

  async create(adminId: string, dto: CreateRewardDto) {
    const id = dto.id ?? this.slug(dto.title);
    if (await this.prisma.reward.findUnique({ where: { id }, select: { id: true } })) {
      throw new ConflictException(`A reward with the id "${id}" already exists`);
    }
    const r = await this.prisma.reward.create({
      data: {
        id,
        title: dto.title.trim(),
        subtitle: dto.subtitle.trim(),
        description: dto.description?.trim() || null,
        coinCost: dto.coinCost,
        stock: dto.stock ?? null,
        active: dto.active ?? true,
        kind: dto.kind,
        imageKey: dto.imageKey ?? null,
        sortOrder: dto.sortOrder ?? 100,
      },
    });
    await this.audit.log({ adminId, action: 'reward.create', entityType: 'reward', entityId: id, summary: `Added "${r.title}" for ${r.coinCost} coins`, after: this.snapshot(r) });
    return this.view(r);
  }

  async update(adminId: string, id: string, dto: UpdateRewardDto) {
    const before = await this.prisma.reward.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Reward not found');
    const data: Prisma.RewardUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.subtitle !== undefined) data.subtitle = dto.subtitle.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.coinCost !== undefined) data.coinCost = dto.coinCost;
    if (dto.stock !== undefined) data.stock = dto.stock;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.imageKey !== undefined) data.imageKey = dto.imageKey;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to change');

    const after = await this.prisma.reward.update({ where: { id }, data });
    const priceChanged = before.coinCost !== after.coinCost;
    await this.audit.log({
      adminId,
      action: 'reward.update',
      entityType: 'reward',
      entityId: id,
      summary: priceChanged ? `Changed "${after.title}": price ${before.coinCost} to ${after.coinCost} coins` : `Edited "${after.title}"`,
      before: this.snapshot(before),
      after: this.snapshot(after),
    });
    return this.view(after);
  }

  /** Only a reward nobody ever redeemed can be deleted; otherwise switch it off. */
  async remove(adminId: string, id: string) {
    const r = await this.prisma.reward.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Reward not found');
    const used = await this.prisma.rewardRedemption.count({ where: { rewardId: id } });
    if (used > 0) throw new ConflictException(`${used} redemptions exist. Switch the reward off instead of deleting it`);
    await this.prisma.reward.delete({ where: { id } });
    await this.audit.log({ adminId, action: 'reward.delete', entityType: 'reward', entityId: id, summary: `Deleted "${r.title}"`, before: this.snapshot(r) });
    return { deleted: true };
  }

  private slug(title: string): string {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
    if (base.length < 3) throw new BadRequestException('Give the reward an id of 3 or more letters');
    return base;
  }

  private view(r: Reward) {
    return { id: r.id, title: r.title, subtitle: r.subtitle, description: r.description, coinCost: r.coinCost, stock: r.stock, active: r.active, kind: r.kind, imageKey: r.imageKey, sortOrder: r.sortOrder };
  }

  private snapshot(r: Reward): Prisma.InputJsonValue {
    return { title: r.title, subtitle: r.subtitle, coinCost: r.coinCost, stock: r.stock, active: r.active, kind: r.kind };
  }
}
