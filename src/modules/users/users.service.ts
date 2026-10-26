import { Injectable, ConflictException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { hashRefreshToken } from '../auth/refresh-tokens.service';
import * as argon2 from 'argon2';
import { PrismaService } from '../../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AttemptSource } from '@prisma/client';
import { AchievementsService } from '../gamification/achievements.service';
import { levelProgress } from '../gamification/levels';
import { GrantResult, LedgerService } from '../ledger/ledger.service';
import { QuizService } from '../quiz/quiz.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private notifications: NotificationsService,
    private ledger: LedgerService,
    private quiz: QuizService,
    private achievements: AchievementsService,
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
        longestStreak: true,
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
      levelInfo: levelProgress(user.xp),
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
    if (dto.subjects) {
      // Only real subjects, each once: a typo here would silently drop a
      // student out of that subject's practice and rankings.
      const unique = [...new Set(dto.subjects)];
      const known = await this.prisma.subject.findMany({ where: { id: { in: unique } }, select: { id: true } });
      const unknown = unique.filter((id) => !known.some((k) => k.id === id));
      if (unknown.length > 0) throw new BadRequestException(`Unknown subject: ${unknown.join(', ')}`);
      data.subjects = JSON.stringify(unique);
    }

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

  async changePassword(userId: string, currentPassword: string, newPassword: string, keepRefreshToken?: string) {
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
    // Older access tokens stop working now (this device's refreshes into a new one by itself).
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash, tokensValidFrom: new Date() } });
    // Sign out every other device. The caller's own login (its refresh token) stays.
    const keep = keepRefreshToken
      ? await this.prisma.refreshToken.findFirst({ where: { userId, tokenHash: hashRefreshToken(keepRefreshToken) }, select: { familyId: true } })
      : null;
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(keep && { familyId: { not: keep.familyId } }) },
      data: { revokedAt: new Date() },
    });

    return { message: 'Password changed successfully' };
  }

  // ─── Delete account ───────────────────────────────────────────────────────────

  /** Hard delete - every owned row (sessions, mastery, activity, rewards,
   *  notifications, ...) cascades via the schema's onDelete: Cascade. */
  async deleteAccount(userId: string) {
    await this.prisma.user.delete({ where: { id: userId } });
    return { message: 'Account deleted' };
  }

  // ─── Claim welcome bonus (100 coins + 50 XP, once per account) ───────────────

  async claimWelcomeBonus(userId: string) {
    const BONUS_COINS = 100;
    const BONUS_XP = 50;

    // The flag flip is the gate: only one concurrent/repeat request can match
    // `welcomeBonusClaimedAt: null`. The ledger key is a second safety net.
    const gate = await this.prisma.user.updateMany({
      where: { id: userId, welcomeBonusClaimedAt: null },
      data: { welcomeBonusClaimedAt: new Date(), streak: 1 /* day 1 */ },
    });
    const alreadyClaimed = gate.count === 0;

    if (!alreadyClaimed) {
      await this.ledger.grant({
        userId,
        xp: BONUS_XP,
        coins: BONUS_COINS,
        reason: 'welcome_bonus',
        key: `welcome_bonus:${userId}`,
      });
      await this.activity.recordXp(userId, BONUS_XP);
      await this.notifications.notify(
        userId,
        'welcome_bonus',
        '🎉 Welcome bonus claimed!',
        `You earned ${BONUS_COINS} coins and ${BONUS_XP} XP. Let's get started!`,
      );
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, coins: true, xp: true, streak: true },
    });

    return {
      ...user,
      alreadyClaimed,
      bonusCoins: alreadyClaimed ? 0 : BONUS_COINS,
      bonusXp: alreadyClaimed ? 0 : BONUS_XP,
    };
  }

  // ─── Complete starter challenge (coins based on correct answers) ──────────────

  /** Most correct answers the one-off starter challenge can pay for. */
  private static readonly STARTER_MAX_REWARDED = 10;

  async completeStarterChallenge(
    userId: string,
    sessionId: string,
    answers: { questionId: string; selectedOptionId: string }[],
  ) {
    const COINS_PER_CORRECT = 10;
    const XP_PER_CORRECT = 10;

    const existing = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { starterChallengeCompletedAt: true },
    });
    if (existing.starterChallengeCompletedAt) {
      throw new ConflictException('Starter challenge already completed');
    }

    // Grade server-side against the questions the server issued for this
    // session, same as the main quiz - never a client-reported count.
    const graded = await this.quiz.gradeAndCloseSession(userId, sessionId, answers, AttemptSource.STARTER);

    // The completion flag is the one-time gate for the badge and rewards.
    const gate = await this.prisma.user.updateMany({
      where: { id: userId, starterChallengeCompletedAt: null },
      data: { starterChallengeCompletedAt: new Date() },
    });
    if (gate.count === 0) {
      throw new ConflictException('Starter challenge already completed');
    }

    const questionsAnswered = graded.questionIds.length;
    const correctAnswers = graded.correctIds.length;
    const rewarded = graded.correctIds.slice(0, UsersService.STARTER_MAX_REWARDED);

    let earnedXp = 0;
    let earnedCoins = 0;
    const grants: GrantResult[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const questionId of rewarded) {
        const res = await this.ledger.grant(
          {
            userId,
            xp: XP_PER_CORRECT,
            coins: COINS_PER_CORRECT,
            reason: 'starter_challenge',
            key: `starter:${userId}:${questionId}`,
            refType: 'question',
            refId: questionId,
          },
          tx,
        );
        grants.push(res);
        earnedXp += res.xp;
        earnedCoins += res.coins;
      }
    });
    const levelUp = LedgerService.mergeLevelUps(grants);
    if (levelUp) this.ledger.announceLevelUp(userId, levelUp);

    await this.prisma.user.update({
      where: { id: userId },
      data: { questionsAnswered: { increment: questionsAnswered } },
    });

    await this.activity.recordQuestions(userId, questionsAnswered);
    await this.activity.recordXp(userId, earnedXp);
    // First Steps and anything else this unlocked (it notifies the student itself).
    const unlocked = await this.achievements.evaluate(userId);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, coins: true, xp: true, questionsAnswered: true, badges: true, state: true },
    });

    const { nationalRank, stateRank } = await this._ranksFor(user.id, user.xp, user.state);

    return {
      ...user,
      earnedCoins,
      earnedXp,
      questionsAnsweredInChallenge: questionsAnswered,
      correctAnswers,
      nationalRank,
      stateRank,
      level: levelProgress(user.xp),
      newAchievements: unlocked.map((x) => ({ key: x.key, name: x.name, description: x.description, icon: x.icon })),
    };
  }

  /** Real ranks by XP - not the Math.random() placeholders this used to
   *  return. `stateRank` is null (not fabricated) if the student hasn't
   *  set a state, since there's nothing real to rank them against. */
  private async _ranksFor(userId: string, xp: number, state: string | null) {
    const [aheadNationally, aheadInState] = await Promise.all([
      this.prisma.user.count({ where: { role: 'STUDENT', xp: { gt: xp } } }),
      state
        ? this.prisma.user.count({ where: { role: 'STUDENT', state, xp: { gt: xp } } })
        : Promise.resolve(null),
    ]);
    return {
      nationalRank: aheadNationally + 1,
      stateRank: aheadInState === null ? null : aheadInState + 1,
    };
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

  // ─── GET /users/search ──────────────────────────────────────────────────────

  /** Looks up students by username/name prefix, for picking a Challenges
   *  opponent. Excludes the caller and admin accounts, and requires at
   *  least 2 characters so it can't be used to enumerate every student -
   *  but otherwise returns every name match, even ones the caller can't
   *  actually challenge right now. Hiding those outright would just be
   *  confusing ("why can't I find my friend by searching?"); instead
   *  each result carries `eligible` + `ineligibleReason` (a different
   *  class level, or - when `subjectId` is given - an open PENDING/
   *  ACTIVE challenge with them for that subject already) so the client
   *  can show *why* rather than silently omitting them.
   *  ChallengesService.create() is the actual enforcement point - this
   *  is purely informational. */
  async searchStudents(callerId: string, q: string, subjectId?: string) {
    const query = q.trim();
    if (query.length < 2) return [];

    const caller = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { classLevel: true },
    });

    const users = await this.prisma.user.findMany({
      where: {
        id: { not: callerId },
        role: 'STUDENT',
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { fullName: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, username: true, fullName: true, avatarUrl: true, classLevel: true },
      take: 15,
      orderBy: { username: 'asc' },
    });
    if (users.length === 0) return users;

    let alreadyOpenWith = new Set<string>();
    if (subjectId) {
      const openChallenges = await this.prisma.challenge.findMany({
        where: {
          subjectId,
          status: { in: ['PENDING', 'ACTIVE'] },
          OR: [
            { challengerId: callerId, opponentId: { in: users.map((u) => u.id) } },
            { opponentId: callerId, challengerId: { in: users.map((u) => u.id) } },
          ],
        },
        select: { challengerId: true, opponentId: true },
      });
      alreadyOpenWith = new Set(
        openChallenges.map((c) => (c.challengerId === callerId ? c.opponentId : c.challengerId)),
      );
    }

    return users.map((u) => {
      let ineligibleReason: string | null = null;
      if (caller && u.classLevel !== caller.classLevel) {
        ineligibleReason = `In ${u.classLevel}, not your class level`;
      } else if (alreadyOpenWith.has(u.id)) {
        ineligibleReason = 'You already have an open challenge with them for this subject';
      }
      return { ...u, eligible: ineligibleReason === null, ineligibleReason };
    });
  }
}