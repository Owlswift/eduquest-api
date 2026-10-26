import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { isMinor } from '../../common/safeguarding';
import { AuditService } from './audit.service';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

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
        age: true,
        guardianName: true,
        guardianPhone: true,
        guardianConsentAt: true,
        policyAcceptedVersion: true,
        policyAcceptedAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return { ...user, isMinor: isMinor(user.age) };
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
    await this.audit.log({
      adminId: adminUserId,
      action: 'user.role',
      entityType: 'user',
      entityId: targetUserId,
      summary: `${target.fullName}: ${target.role} to ${role}`,
      before: { role: target.role },
      after: { role },
    });
    return updated;
  }

  /** A parent or guardian asked for their agreement to be withdrawn: the student can no longer enter prize competitions or claim prizes. */
  async withdrawGuardianConsent(adminId: string, userId: string, reason: string) {
    const r = await this.prisma.user.updateMany({
      where: { id: userId, guardianConsentAt: { not: null } },
      data: { guardianConsentAt: null, guardianConsentVersion: null },
    });
    if (r.count === 0) throw new NotFoundException('That student has no guardian agreement on file');
    await this.audit.log({ adminId, action: 'user.guardian_consent_withdrawn', entityType: 'user', entityId: userId, summary: `Guardian agreement withdrawn: ${reason}` });
    return { withdrawn: true };
  }

  /**
   * Erases an account (for example on a parent or guardian's request). Everything the student owns goes with
   * it. An administrator cannot be erased here, nor can you erase yourself. The reason is kept in the audit log,
   * which holds no personal details beyond the id.
   */
  async eraseStudent(adminId: string, userId: string, reason: string) {
    if (userId === adminId) throw new BadRequestException('You cannot erase your own account here');
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, username: true } });
    if (!u) throw new NotFoundException('User not found');
    if (u.role !== 'STUDENT') throw new BadRequestException('Only student accounts can be erased here');
    await this.audit.log({ adminId, action: 'user.erase', entityType: 'user', entityId: userId, summary: `Erased a student account: ${reason}` });
    await this.prisma.user.delete({ where: { id: userId } });
    return { erased: true };
  }
}
