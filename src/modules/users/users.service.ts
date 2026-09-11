import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
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

    if (dto.classLevel) data.classLevel = dto.classLevel;
    if (dto.state) data.state = dto.state;
    if (dto.subjects) data.subjects = JSON.stringify(dto.subjects);

    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
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

    return {
      ...user,
      bonusCoins: BONUS_COINS,
      bonusXp: BONUS_XP,
    };
  }

  // ─── Complete starter challenge (coins based on correct answers) ──────────────

  async completeStarterChallenge(userId: string, correctAnswers: number) {
    const COINS_PER_CORRECT = 10;
    const XP_PER_CORRECT = 10;
    const QUESTIONS_ANSWERED = 5;

    const earnedCoins = correctAnswers * COINS_PER_CORRECT;
    const earnedXp = correctAnswers * XP_PER_CORRECT;

    // Get current user stats to calculate new rank placeholders
    const totalUsers = await this.prisma.user.count();

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        coins: { increment: earnedCoins },
        xp: { increment: earnedXp },
        questionsAnswered: { increment: QUESTIONS_ANSWERED },
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

    await this.activity.recordQuestions(userId, QUESTIONS_ANSWERED);

    // Calculate approximate rank (simplified — replace with real ranking query)
    const nationalRank = Math.max(1, totalUsers - Math.floor(Math.random() * 100));
    const stateRank = Math.max(1, Math.floor(totalUsers * 0.1) - Math.floor(Math.random() * 20));

    return {
      ...user,
      earnedCoins,
      earnedXp,
      questionsAnsweredInChallenge: QUESTIONS_ANSWERED,
      correctAnswers,
      nationalRank,
      stateRank,
    };
  }

  // ─── All-time leaderboard (ranked by total XP) ───────────────────────────────

  private firstName(fullName: string): string {
    const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
    if (!first) return 'Student';
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  async getLeaderboard(userId: string, limit = 20) {
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
}