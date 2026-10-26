import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../admin/audit.service';
import { MAX_LOGO_BYTES, sniffLogo, sponsorLogoUrl } from './logo';

export interface SponsorInput {
  name?: string;
  websiteUrl?: string | null;
}

@Injectable()
export class SponsorsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.sponsor.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, websiteUrl: true, logoUpdatedAt: true, createdAt: true, _count: { select: { competitions: true } } },
    });
    return rows.map((s) => this.view(s));
  }

  async create(adminId: string, input: SponsorInput, logo: Buffer | undefined) {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('A sponsor needs a name');
    if (!logo) throw new BadRequestException('A sponsor needs a logo');
    const logoType = this.checkedLogo(logo);
    try {
      const s = await this.prisma.sponsor.create({
        data: { name, websiteUrl: input.websiteUrl?.trim() || null, logoData: new Uint8Array(logo), logoType },
        select: { id: true, name: true, websiteUrl: true, logoUpdatedAt: true, createdAt: true },
      });
      await this.audit.log({ adminId, action: 'sponsor.create', entityType: 'sponsor', entityId: s.id, summary: `Added sponsor "${s.name}"`, after: { name: s.name } });
      return this.view({ ...s, _count: { competitions: 0 } });
    } catch (e) {
      this.rethrowDuplicateName(e, name);
    }
  }

  async update(adminId: string, id: string, input: SponsorInput, logo: Buffer | undefined) {
    const before = await this.prisma.sponsor.findUnique({ where: { id }, select: { name: true, websiteUrl: true } });
    if (!before) throw new NotFoundException('Sponsor not found');
    const data: Prisma.SponsorUpdateInput = {};
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new BadRequestException('A sponsor needs a name');
      data.name = input.name.trim();
    }
    if (input.websiteUrl !== undefined) data.websiteUrl = input.websiteUrl?.trim() || null;
    if (logo) Object.assign(data, { logoData: new Uint8Array(logo), logoType: this.checkedLogo(logo), logoUpdatedAt: new Date() });
    try {
      const s = await this.prisma.sponsor.update({
        where: { id },
        data,
        select: { id: true, name: true, websiteUrl: true, logoUpdatedAt: true, createdAt: true, _count: { select: { competitions: true } } },
      });
      await this.audit.log({ adminId, action: 'sponsor.update', entityType: 'sponsor', entityId: id, summary: `Edited sponsor "${s.name}"${logo ? ' (new logo)' : ''}`, before, after: { name: s.name, websiteUrl: s.websiteUrl } });
      return this.view(s);
    } catch (e) {
      this.rethrowDuplicateName(e, input.name ?? before.name);
    }
  }

  /** Not while a competition that is open, running or waiting for results still shows it. */
  async remove(adminId: string, id: string) {
    const s = await this.prisma.sponsor.findUnique({ where: { id }, select: { name: true } });
    if (!s) throw new NotFoundException('Sponsor not found');
    const inUse = await this.prisma.competition.count({ where: { sponsorId: id, status: { in: ['DRAFT', 'PUBLISHED', 'ACTIVE', 'CLOSED'] } } });
    if (inUse > 0) throw new ConflictException(inUse === 1 ? '1 competition still shows this sponsor. Remove it from that competition first' : `${inUse} competitions still show this sponsor. Remove it from them first`);
    await this.prisma.sponsor.delete({ where: { id } });
    await this.audit.log({ adminId, action: 'sponsor.delete', entityType: 'sponsor', entityId: id, summary: `Deleted sponsor "${s.name}"`, before: { name: s.name } });
    return { deleted: true };
  }

  /** The logo bytes for the public image endpoint. */
  async logo(id: string) {
    const s = await this.prisma.sponsor.findUnique({ where: { id }, select: { logoData: true, logoType: true, logoUpdatedAt: true } });
    if (!s) throw new NotFoundException('Sponsor not found');
    return { data: Buffer.from(s.logoData), type: s.logoType, updatedAt: s.logoUpdatedAt };
  }

  private checkedLogo(logo: Buffer) {
    if (logo.length > MAX_LOGO_BYTES) throw new BadRequestException(`The logo is too large. Keep it under ${Math.round(MAX_LOGO_BYTES / 1024)} KB`);
    const type = sniffLogo(logo);
    if (!type) throw new BadRequestException('The logo must be a PNG, JPEG or WebP image');
    return type;
  }

  private rethrowDuplicateName(e: unknown, name: string): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`A sponsor called "${name}" already exists`);
    throw e;
  }

  private view(s: { id: string; name: string; websiteUrl: string | null; logoUpdatedAt: Date; createdAt: Date; _count: { competitions: number } }) {
    return { id: s.id, name: s.name, websiteUrl: s.websiteUrl, logoUrl: sponsorLogoUrl(s), competitions: s._count.competitions, createdAt: s.createdAt };
  }
}
