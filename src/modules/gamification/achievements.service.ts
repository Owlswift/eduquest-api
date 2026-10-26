import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AchievementDef, AchievementStats, ACHIEVEMENTS } from './achievements.catalog';

export interface AchievementView extends AchievementDef {
  current: number;
  unlocked: boolean;
  unlockedAt: Date | null;
}

@Injectable()
export class AchievementsService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
  ) {}

  /** The verified numbers every achievement is checked against. */
  async stats(userId: string): Promise<AchievementStats> {
    const [user, correct, quizzes, perfect, won, daily, exams, subjectCerts, podiums, entered] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { questionsAnswered: true, longestStreak: true, level: true },
      }),
      this.prisma.subjectStat.aggregate({ where: { userId }, _sum: { correctAnswers: true } }),
      this.prisma.quizSession.count({ where: { userId, status: 'SUBMITTED' } }),
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "QuizSession"
         WHERE "userId" = ${userId} AND "status" = 'SUBMITTED'::"QuizSessionStatus"
           AND cardinality("questionIds") >= 5 AND "correctCount" = cardinality("questionIds")`,
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "Challenge"
         WHERE "status" = 'COMPLETED'::"ChallengeStatus"
           AND (("challengerId" = ${userId} AND "challengerScore" > "opponentScore")
             OR ("opponentId" = ${userId} AND "opponentScore" > "challengerScore"))`,
      this.prisma.quizSession.count({ where: { userId, status: 'SUBMITTED', dailyChallengeId: { not: null } } }),
      this.prisma.examSession.count({ where: { userId, status: 'SUBMITTED' } }),
      // Only mastery certificates: competition certificates are a different achievement.
      this.prisma.certificate.count({ where: { userId, kind: 'SUBJECT' } }),
      this.prisma.competitionParticipant.count({ where: { userId, rank: { gte: 1, lte: 3 } } }),
      this.prisma.competitionParticipant.count({ where: { userId, status: 'COMPLETED' } }),
    ]);
    return {
      quizzes,
      questionsAnswered: user?.questionsAnswered ?? 0,
      correctAnswers: correct._sum.correctAnswers ?? 0,
      perfectQuizzes: perfect[0]?.n ?? 0,
      longestStreak: user?.longestStreak ?? 0,
      level: user?.level ?? 1,
      challengesWon: won[0]?.n ?? 0,
      certificates: subjectCerts,
      competitionPodiums: podiums,
      competitionsEntered: entered,
      dailyChallenges: daily,
      examsCompleted: exams,
    };
  }

  /** The full catalogue with this student's progress, unlocked first. */
  async list(userId: string): Promise<AchievementView[]> {
    const [stats, rows] = await Promise.all([
      this.stats(userId),
      this.prisma.userAchievement.findMany({ where: { userId } }),
    ]);
    const at = new Map(rows.map((r) => [r.key, r.unlockedAt]));
    return ACHIEVEMENTS.map((a) => ({
      ...a,
      current: Math.min(stats[a.stat], a.target),
      unlocked: at.has(a.key),
      unlockedAt: at.get(a.key) ?? null,
    })).sort((x, y) => Number(y.unlocked) - Number(x.unlocked));
  }

  /**
   * Unlocks every achievement the student now qualifies for. Safe to call
   * after any event and any number of times: an unlock is recorded once
   * (unique key), and its reward is paid once through the ledger in the same
   * transaction. Resolves to the achievements unlocked by THIS call.
   */
  async evaluate(userId: string): Promise<AchievementDef[]> {
    const [stats, owned] = await Promise.all([
      this.stats(userId),
      this.prisma.userAchievement.findMany({ where: { userId }, select: { key: true } }),
    ]);
    const have = new Set(owned.map((o) => o.key));
    const due = ACHIEVEMENTS.filter((a) => !have.has(a.key) && stats[a.stat] >= a.target);

    const unlocked: AchievementDef[] = [];
    let levelUp: { from: number; to: number } | undefined;
    for (const a of due) {
      const grants: Awaited<ReturnType<LedgerService['grant']>>[] = [];
      const isNew = await this.prisma.$transaction(async (tx) => {
        const created = await tx.userAchievement.createMany({
          data: [{ userId, key: a.key }],
          skipDuplicates: true,
        });
        if (created.count === 0) return false; // a concurrent call won
        if (a.rewardXp > 0 || a.rewardCoins > 0) {
          grants.push(
            await this.ledger.grant(
              {
                userId,
                xp: a.rewardXp,
                coins: a.rewardCoins,
                reason: 'achievement',
                key: `achievement:${userId}:${a.key}`,
                refType: 'achievement',
                refId: a.key,
              },
              tx,
            ),
          );
        }
        return true;
      });
      if (!isNew) continue;
      unlocked.push(a);
      const up = LedgerService.mergeLevelUps(grants);
      if (up) levelUp = { from: levelUp?.from ?? up.from, to: up.to };
      await this.notifications.notify(
        userId,
        'achievement_unlocked',
        `Achievement unlocked: ${a.name}`,
        a.description,
        { key: a.key },
      );
    }

    if (unlocked.length > 0) {
      const badges = await this.prisma.userAchievement.count({ where: { userId } });
      await this.prisma.user.update({ where: { id: userId }, data: { badges } });
    }
    if (levelUp) this.ledger.announceLevelUp(userId, levelUp);
    return unlocked;
  }
}
