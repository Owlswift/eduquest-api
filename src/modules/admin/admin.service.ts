import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // ─── GET /admin/overview ────────────────────────────────────────────────────

  async overview() {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalStudents,
      totalAdmins,
      coinsAndXp,
      pendingRedemptions,
      activeCompetitions,
      newUsersLast7Days,
      certificatesAwarded,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: 'STUDENT' } }),
      this.prisma.user.count({ where: { role: 'ADMIN' } }),
      this.prisma.user.aggregate({ _sum: { coins: true, xp: true } }),
      this.prisma.rewardRedemption.count({ where: { status: 'PENDING' } }),
      this.prisma.competition.count({ where: { startsAt: { lte: now }, endsAt: { gte: now } } }),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.certificate.count(),
    ]);

    return {
      totalStudents,
      totalAdmins,
      totalCoinsInCirculation: coinsAndXp._sum.coins ?? 0,
      totalXpInCirculation: coinsAndXp._sum.xp ?? 0,
      pendingRedemptions,
      activeCompetitions,
      newUsersLast7Days,
      certificatesAwarded,
    };
  }

  // ─── GET /admin/users?search=&page=&limit= ─────────────────────────────────

  async listUsers(search: string | undefined, page: number, limit: number) {
    const where = search
      ? {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' as const } },
            { username: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          fullName: true,
          username: true,
          email: true,
          role: true,
          xp: true,
          coins: true,
          classLevel: true,
          state: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total, page, limit };
  }

  // ─── GET /admin/users/:id ───────────────────────────────────────────────────

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        username: true,
        email: true,
        phone: true,
        role: true,
        classLevel: true,
        state: true,
        coins: true,
        xp: true,
        level: true,
        badges: true,
        certificates: true,
        streak: true,
        questionsAnswered: true,
        accuracy: true,
        timeSpent: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ─── PATCH /admin/users/:id/role ────────────────────────────────────────────

  async updateUserRole(adminUserId: string, targetUserId: string, role: UserRole) {
    if (adminUserId === targetUserId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { role },
      select: { id: true, fullName: true, role: true },
    });
    return updated;
  }
}
