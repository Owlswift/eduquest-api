import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class CompetitionsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  private status(now: Date, startsAt: Date, endsAt: Date): 'upcoming' | 'ongoing' | 'ended' {
    if (now < startsAt) return 'upcoming';
    if (now > endsAt) return 'ended';
    return 'ongoing';
  }

  // ─── GET /competitions ────────────────────────────────────────────────────

  async list(userId: string) {
    const [competitions, myEntries] = await Promise.all([
      this.prisma.competition.findMany({
        orderBy: { startsAt: 'asc' },
        include: { _count: { select: { participants: true } } },
      }),
      this.prisma.competitionParticipant.findMany({
        where: { userId },
        select: { competitionId: true },
      }),
    ]);
    const joinedIds = new Set(myEntries.map((e) => e.competitionId));
    const now = new Date();

    return competitions.map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      prizes: c.prizes as string[],
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      status: this.status(now, c.startsAt, c.endsAt),
      participantCount: c._count.participants,
      isJoined: joinedIds.has(c.id),
    }));
  }

  // ─── POST /competitions/:id/join ─────────────────────────────────────────

  async join(userId: string, competitionId: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
    });
    if (!competition) throw new NotFoundException('Competition not found');
    if (new Date() > competition.endsAt) {
      throw new BadRequestException('This competition has already ended');
    }

    const alreadyJoined = await this.prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
      select: { id: true },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { xp: true },
    });

    await this.prisma.competitionParticipant.upsert({
      where: { competitionId_userId: { competitionId, userId } },
      create: { competitionId, userId, xpAtJoin: user?.xp ?? 0 },
      update: {}, // already joined - no-op, idempotent
    });

    if (!alreadyJoined) {
      await this.notifications.notify(
        userId,
        'competition_joined',
        '🏆 Competition joined!',
        `You joined ${competition.title}. Good luck!`,
        { competitionId },
      );
    }

    return { joined: true };
  }

  // ─── GET /competitions/:id/leaderboard ───────────────────────────────────

  async leaderboard(userId: string, competitionId: string, limit = 20) {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
    });
    if (!competition) throw new NotFoundException('Competition not found');

    const entries = await this.prisma.competitionParticipant.findMany({
      where: { competitionId },
      include: { user: { select: { id: true, fullName: true, xp: true } } },
    });

    const ranked = entries
      .map((e) => ({
        userId: e.userId,
        name: this.firstName(e.user.fullName),
        xpEarned: Math.max(0, e.user.xp - e.xpAtJoin),
        isMe: e.userId === userId,
      }))
      .sort((a, b) => b.xpEarned - a.xpEarned)
      .map((e, i) => ({ rank: i + 1, ...e }));

    const me = ranked.find((e) => e.isMe) ?? null;

    return { top: ranked.slice(0, limit), me };
  }

  private firstName(fullName: string): string {
    const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
    if (!first) return 'Student';
    return first.charAt(0).toUpperCase() + first.slice(1);
  }
}
