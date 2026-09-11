import { Injectable, ConflictException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private notifications: NotificationsService,
  ) {}

  // ─── Get profile ────────────────────────────────────────────────────────────

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        username: true,
        email: true,
        phone: true,
        avatarUrl: true,
        classLevel: true,
        examTarget: true,
        state: true,
        interests: true,
        subjects: true,
        level: true,
        coins: true,
        xp: true,
        maxXp: true,
        badges: true,
        certificates: true,
        streak: true,
        questionsAnswered: true,
        accuracy: true,
        timeSpent: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) throw new Error('User not found');

    return {
      ...user,
      // Parse interests back from JSON string to array
      interests: user.interests ? JSON.parse(user.interests) : [],
      // Parse subjects back from JSON string to array
      subjects: user.subjects ? JSON.parse(user.subjects) : [],
    };
  }

  // ─── Update profile (post-registration flow) ─────────────────────────────────

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: any = {};

    if (dto.fullName) data.fullName = dto.fullName.toLowerCase().trim();
    if (dto.phone) data.phone = dto.phone.toLowerCase().trim();
    if (dto.classLevel) data.classLevel = dto.classLevel;
    if (dto.state) data.state = dto.state;
    if (dto.subjects) data.subjects = JSON.stringify(dto.subjects);

    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          fullName: true,
          phone: true,
          classLevel: true,
          state: true,
          interests: true,
          subjects: true,
        },
      });

      return {
        ...user,
        interests: user.interests ? JSON.parse(user.interests) : [],
        subjects: user.subjects ? JSON.parse(user.subjects) : [],
      };
    } catch (error: any) {
      // Handle unique constraint violations gracefully
      if (error.code === 'P2002') {
        const constraint = error.meta?.constraint?.fields?.[0];
        
        if (constraint === 'phone') {
          throw new ConflictException('This phone number is already in use by another account');
        }
      }
      
      // Re-throw other errors
      throw error;
    }
  }

  // ─── Change password (while logged in) ───────────────────────────────────────

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    if (!user.passwordHash) {
      throw new BadRequestException(
        'This account uses Google Sign-In and has no password to change.',
      );
    }

    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const hash = await argon2.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });

    return { message: 'Password changed successfully' };
  }

  // ─── Delete account ───────────────────────────────────────────────────────────

  /** Hard delete - every owned row (sessions, mastery, activity, rewards,
   *  notifications, ...) cascades via the schema's onDelete: Cascade. */
  async deleteAccount(userId: string) {
    await this.prisma.user.delete({ where: { id: userId } });
    return { message: 'Account deleted' };
  }

  // ─── Claim welcome bonus (100 coins + 50 XP) ─────────────────────────────────

  async claimWelcomeBonus(userId: string) {
    const BONUS_COINS = 100;
    const BONUS_XP = 50;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        coins: { increment: BONUS_COINS },
        xp: { increment: BONUS_XP },
        streak: 1, // Start streak on day 1
      },
      select: {
        id: true,
        coins: true,
        xp: true,
        streak: true,
      },
    });

    await this.activity.recordXp(userId, BONUS_XP);
    await this.notifications.notify(
      userId,
      'welcome_bonus',
      '🎉 Welcome bonus claimed!',
      `You earned ${BONUS_COINS} coins and ${BONUS_XP} XP. Let's get started!`,
    );

    return {
      ...user,
      bonusCoins: BONUS_COINS,
      bonusXp: BONUS_XP,
    };
  }

  // ─── Complete starter challenge (coins based on correct answers) ──────────────

  async completeStarterChallenge(
    userId: string,
    answers: { questionId: string; selectedOptionId: string }[],
  ) {
    const COINS_PER_CORRECT = 10;
    const XP_PER_CORRECT = 10;

    // Grade server-side, same as the main quiz - don't trust a
    // client-reported correctAnswers count.
    const questions = await this.prisma.question.findMany({
      where: { id: { in: answers.map((a) => a.questionId) } },
      select: { id: true, correctAnswerId: true },
    });
    const correctById = new Map(questions.map((q) => [q.id, q.correctAnswerId]));

    const questionsAnswered = answers.length;
    const correctAnswers = answers.filter(
      (a) => correctById.get(a.questionId) === a.selectedOptionId,
    ).length;

    const earnedCoins = correctAnswers * COINS_PER_CORRECT;
    const earnedXp = correctAnswers * XP_PER_CORRECT;

    // Get current user stats to calculate new rank placeholders
    const totalUsers = await this.prisma.user.count();

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        coins: { increment: earnedCoins },
        xp: { increment: earnedXp },
        questionsAnswered: { increment: questionsAnswered },
        badges: { increment: 1 }, // First Steps badge
      },
      select: {
        id: true,
        coins: true,
        xp: true,
        questionsAnswered: true,
        badges: true,
      },
    });

    await this.activity.recordQuestions(userId, questionsAnswered);
    await this.activity.recordXp(userId, earnedXp);
    await this.notifications.notify(
      userId,
      'badge_earned',
      '🏅 First Steps badge earned!',
      `You got ${correctAnswers}/${questionsAnswered} right on your starter challenge.`,
    );

    // Calculate approximate rank (simplified — replace with real ranking query)
    const nationalRank = Math.max(1, totalUsers - Math.floor(Math.random() * 100));
    const stateRank = Math.max(1, Math.floor(totalUsers * 0.1) - Math.floor(Math.random() * 20));

    return {
      ...user,
      earnedCoins,
      earnedXp,
      questionsAnsweredInChallenge: questionsAnswered,
      correctAnswers,
      nationalRank,
      stateRank,
    };
  }

  // ─── Leaderboard (ranked by XP - all-time total, or earned within a
  // weekly/monthly window via DailyActivity.xpEarned) ─────────────────────────

  private firstName(fullName: string): string {
    const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
    if (!first) return 'Student';
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  async getLeaderboard(
    userId: string,
    limit = 20,
    period: 'all' | 'weekly' | 'monthly' = 'all',
  ) {
    if (period === 'all') return this._leaderboardAllTime(userId, limit);
    return this._leaderboardForWindow(userId, limit, period === 'weekly' ? 7 : 30);
  }

  private async _leaderboardAllTime(userId: string, limit: number) {
    const [rows, me] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'STUDENT' },
        orderBy: [{ xp: 'desc' }, { createdAt: 'asc' }],
        take: limit,
        select: { id: true, fullName: true, xp: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, xp: true },
      }),
    ]);

    const top = rows.map((u, i) => ({
      rank: i + 1,
      name: this.firstName(u.fullName),
      xp: u.xp,
      isMe: u.id === userId,
    }));

    let meEntry: { rank: number; name: string; xp: number } | null = null;
    if (me) {
      const ahead = await this.prisma.user.count({
        where: { role: 'STUDENT', xp: { gt: me.xp } },
      });
      meEntry = {
        rank: ahead + 1,
        name: this.firstName(me.fullName),
        xp: me.xp,
      };
    }

    return { top, me: meEntry };
  }

  /** Ranks by XP earned in the last `days` days (DailyActivity.xpEarned),
   *  not lifetime total - a student who was inactive this window ranks at
   *  the bottom (0) even with a high all-time total. Only students with
   *  at least one active day in the window appear, since 0-XP students
   *  can't be meaningfully ranked against each other. */
  private async _leaderboardForWindow(userId: string, limit: number, days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const grouped = await this.prisma.dailyActivity.groupBy({
      by: ['userId'],
      where: { date: { gte: since } },
      _sum: { xpEarned: true },
    });

    const totals = grouped
      .map((g) => ({ userId: g.userId, xp: g._sum.xpEarned ?? 0 }))
      .filter((t) => t.xp > 0)
      .sort((a, b) => b.xp - a.xp);

    const topIds = totals.slice(0, limit).map((t) => t.userId);
    const myTotal = totals.find((t) => t.userId === userId);

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set([...topIds, userId])] }, role: 'STUDENT' },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(users.map((u) => [u.id, this.firstName(u.fullName)]));

    const top = totals.slice(0, limit).map((t, i) => ({
      rank: i + 1,
      name: nameById.get(t.userId) ?? 'Student',
      xp: t.xp,
      isMe: t.userId === userId,
    }));

    let meEntry: { rank: number; name: string; xp: number } | null = null;
    if (myTotal) {
      const ahead = totals.filter((t) => t.xp > myTotal.xp).length;
      meEntry = {
        rank: ahead + 1,
        name: nameById.get(userId) ?? 'Student',
        xp: myTotal.xp,
      };
    }

    return { top, me: meEntry };
  }

  // ─── Per-subject progress (for the Profile tab) ──────────────────────────────

  /**
   * Average tutor mastery score per subject the student has actually
   * studied. Only subjects with at least one StudentMastery row are
   * returned - no fabricated rows for subjects never touched.
   */
  async getSubjectProgress(userId: string) {
    const rows = await this.prisma.studentMastery.groupBy({
      by: ['subjectId'],
      where: { userId },
      _avg: { masteryScore: true },
    });
    if (rows.length === 0) return [];

    const subjects = await this.prisma.subject.findMany({
      where: { id: { in: rows.map((r) => r.subjectId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(subjects.map((s) => [s.id, s.name]));

    return rows
      .map((r) => ({
        subjectId: r.subjectId,
        subjectName: nameById.get(r.subjectId) ?? r.subjectId,
        progress: Math.round(r._avg.masteryScore ?? 0) / 100,
      }))
      .sort((a, b) => b.progress - a.progress);
  }
}