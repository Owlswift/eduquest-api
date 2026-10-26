import { Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { publicName } from '../../common/names';
import { PrismaService } from '../../database/prisma.service';
import { AchievementsService } from '../gamification/achievements.service';
import { renderCertificatePdf } from './certificate-pdf';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class CertificatesService {
  /** Minimum distinct topics studied in a subject before a certificate can
   *  be considered - stops a single lucky topic from qualifying. */
  private static readonly MIN_TOPICS = 3;
  private static readonly MASTERY_THRESHOLD = 80;

  /** No I, L, O, 0 or 1: a code read aloud or copied by hand stays unambiguous. */
  private static readonly CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  /** A fresh public verification code such as `EQ-7KQ2M-9XDRT`. */
  static newCode(): string {
    const pick = (n: number) =>
      Array.from({ length: n }, () => CertificatesService.CODE_ALPHABET[randomInt(CertificatesService.CODE_ALPHABET.length)]).join('');
    return `EQ-${pick(5)}-${pick(5)}`;
  }

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private achievements: AchievementsService,
  ) {}

  // ─── GET /certificates ──────────────────────────────────────────────────────

  async list(userId: string) {
    const certificates = await this.prisma.certificate.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return certificates.map((c) => ({
      id: c.id,
      // Older clients read these three.
      subjectId: c.subjectId,
      subjectName: c.subjectName,
      earnedAt: c.createdAt,
      kind: c.kind,
      title: c.title ?? (c.kind === 'SUBJECT' ? `${c.subjectName} mastery` : c.subjectName),
      competitionId: c.competitionId,
      rank: c.rank,
      verificationCode: c.verificationCode,
    }));
  }

  /** The certificate as a PDF, for its owner only: it carries the full name, which the public check never shows. */
  async pdf(userId: string, id: string): Promise<{ filename: string; data: Buffer }> {
    const c = await this.prisma.certificate.findFirst({ where: { id, userId }, include: { user: { select: { fullName: true } } } });
    if (!c) throw new NotFoundException('Certificate not found');
    const data = await renderCertificatePdf({
      kind: c.kind,
      title: c.title ?? (c.kind === 'SUBJECT' ? `${c.subjectName} mastery` : c.subjectName),
      subjectName: c.subjectName,
      rank: c.rank,
      holderName: c.user.fullName,
      issuedAt: c.createdAt,
      verificationCode: c.verificationCode,
    });
    return { filename: `eduquest-certificate-${c.verificationCode}.pdf`, data };
  }

  /**
   * Public check that a certificate is real: anyone with the code (a school, a
   * sponsor) can confirm who earned it and for what, without logging in. Shows
   * only a first name and surname initial.
   */
  async verify(rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const c = await this.prisma.certificate.findUnique({
      where: { verificationCode: code },
      include: { user: { select: { fullName: true } } },
    });
    if (!c) return { valid: false as const };
    const competition = c.competitionId
      ? await this.prisma.competition.findUnique({ where: { id: c.competitionId }, select: { title: true, type: true, endsAt: true } })
      : null;
    return {
      valid: true as const,
      verificationCode: c.verificationCode,
      kind: c.kind,
      title: c.title ?? c.subjectName,
      holder: publicName(c.user.fullName),
      rank: c.rank,
      competition: competition ? { title: competition.title, type: competition.type, endedAt: competition.endsAt } : null,
      subject: c.kind === 'SUBJECT' ? c.subjectName : null,
      issuedAt: c.createdAt,
    };
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

    for (let attempt = 0; ; attempt++) {
      try {
        await this.prisma.$transaction([
          this.prisma.certificate.create({
            data: { userId, kind: 'SUBJECT', subjectId, subjectName, title: `${subjectName} mastery`, verificationCode: CertificatesService.newCode() },
          }),
          this.prisma.user.update({ where: { id: userId }, data: { certificates: { increment: 1 } } }),
        ]);
        break;
      } catch (e) {
        // A clash on the (astronomically unlikely) code, or a concurrent award for the same subject.
        const clash = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!clash) throw e;
        const nowExists = await this.prisma.certificate.findFirst({ where: { userId, subjectId } });
        if (nowExists || attempt >= 3) return;
      }
    }

    await this.notifications.notify(
      userId,
      'certificate_earned',
      '🎓 Certificate earned!',
      `You earned a certificate in ${subjectName} for reaching ${CertificatesService.MASTERY_THRESHOLD}%+ mastery.`,
      { subjectId },
    );
    await this.achievements.evaluate(userId); // Topic Expert
  }
}
