import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Append-only record of sensitive admin actions (PRODUCT.md section 17.1). */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(entry: {
    adminId: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  }) {
    await this.prisma.adminAuditLog.create({ data: entry });
  }

  /** Most recent entries for one record, newest first. */
  history(entityType: string, entityId: string, limit = 50) {
    return this.prisma.adminAuditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { admin: { select: { id: true, fullName: true, email: true } } },
    });
  }
}
