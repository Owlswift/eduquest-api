import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class CertificatesService {
  /** Minimum distinct topics studied in a subject before a certificate can
   *  be considered - stops a single lucky topic from qualifying. */
  private static readonly MIN_TOPICS = 3;
  private static readonly MASTERY_THRESHOLD = 80;

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ─── GET /certificates ──────────────────────────────────────────────────────

  async list(userId: string) {
    const certificates = await this.prisma.certificate.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return certificates.map((c) => ({
      id: c.id,
      subjectId: c.subjectId,
      subjectName: c.subjectName,
      earnedAt: c.createdAt,
    }));
  }

  /** Call after any StudentMastery update. Awards a certificate for
   *  `subjectId` the first time the student's average mastery across
   *  their studied topics in that subject crosses the threshold - a
   *  no-op if they already have one, or don't qualify yet. */
  async checkAndAward(userId: string, subjectId: string) {
    const existing = await this.prisma.certificate.findUnique({
      where: { userId_subjectId: { userId, subjectId } },
    });
    if (existing) return;

    const agg = await this.prisma.studentMastery.aggregate({
      where: { userId, subjectId },
      _avg: { masteryScore: true },
      _count: { _all: true },
    });
    if (
      agg._count._all < CertificatesService.MIN_TOPICS ||
      (agg._avg.masteryScore ?? 0) < CertificatesService.MASTERY_THRESHOLD
    ) {
      return;
    }

    const subject = await this.prisma.subject.findUnique({ where: { id: subjectId } });
    const subjectName = subject?.name ?? subjectId;

    await this.prisma.$transaction([
      this.prisma.certificate.create({ data: { userId, subjectId, subjectName } }),
      this.prisma.user.update({ where: { id: userId }, data: { certificates: { increment: 1 } } }),
    ]);

    await this.notifications.notify(
      userId,
      'certificate_earned',
      '🎓 Certificate earned!',
      `You earned a certificate in ${subjectName} for reaching ${CertificatesService.MASTERY_THRESHOLD}%+ mastery.`,
      { subjectId },
    );
  }
}
