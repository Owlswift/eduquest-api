import { BadRequestException, Injectable } from '@nestjs/common';
import { maskPhone, normalisePhone } from '../../common/phone';
import { guardianConsentMissing, isMinor, loadPolicy, parseAge, safeguardingEnforced } from '../../common/safeguarding';
import { PrismaService } from '../../database/prisma.service';

/** A student's own safeguarding record: parent or guardian agreement, policy acceptance, and a copy of their data. */
@Injectable()
export class SafeguardingService {
  constructor(private prisma: PrismaService) {}

  async status(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { age: true, guardianName: true, guardianPhone: true, guardianConsentAt: true, policyAcceptedVersion: true, policyAcceptedAt: true },
    });
    const policy = loadPolicy();
    return {
      age: parseAge(u.age),
      isMinor: isMinor(u.age),
      // True when something the student wants to do (prize competitions, receiving a prize) is blocked until a parent or guardian agrees.
      guardianConsentNeeded: guardianConsentMissing(u),
      enforced: safeguardingEnforced(),
      guardian: u.guardianConsentAt ? { name: u.guardianName, phone: maskPhone(u.guardianPhone), agreedAt: u.guardianConsentAt } : null,
      policy: { currentVersion: policy.version, acceptedVersion: u.policyAcceptedVersion, accepted: u.policyAcceptedVersion === policy.version, acceptedAt: u.policyAcceptedAt },
    };
  }

  /** Records a parent or guardian's agreement. Replaces any earlier details. */
  async setGuardian(userId: string, dto: { guardianName: string; guardianPhone: string }) {
    const phone = normalisePhone(dto.guardianPhone);
    if (!phone) throw new BadRequestException('Enter a valid Nigerian phone number for your parent or guardian, for example 0803 123 4567');
    const name = dto.guardianName.trim();
    if (name.length < 2) throw new BadRequestException("Enter your parent or guardian's name");
    await this.prisma.user.update({
      where: { id: userId },
      data: { guardianName: name, guardianPhone: phone, guardianConsentAt: new Date(), guardianConsentVersion: loadPolicy().version },
    });
    return this.status(userId);
  }

  async acceptPolicy(userId: string, version: string) {
    const current = loadPolicy().version;
    if (version !== current) throw new BadRequestException(`That is not the current policy version (${current}). Fetch it again`);
    await this.prisma.user.update({ where: { id: userId }, data: { policyAcceptedVersion: current, policyAcceptedAt: new Date() } });
    return this.status(userId);
  }

  /**
   * Everything we hold about the student, as one document they can keep (a person's right to see their
   * information). Includes nothing about anyone else, and never the password hash or login tokens.
   */
  async exportData(userId: string) {
    const [user, stats, activity, ledger, entries, prizes, certificates, redemptions, tutor, achievements] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true, fullName: true, username: true, email: true, phone: true, country: true, state: true, institution: true, age: true, interests: true, subjects: true,
          classLevel: true, examTarget: true, coins: true, xp: true, level: true, streak: true, longestStreak: true, createdAt: true,
          guardianName: true, guardianPhone: true, guardianConsentAt: true, policyAcceptedVersion: true, policyAcceptedAt: true,
        },
      }),
      this.prisma.subjectStat.findMany({ where: { userId } }),
      this.prisma.dailyActivity.findMany({ where: { userId }, orderBy: { date: 'desc' }, take: 400 }),
      this.prisma.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 1000, select: { currency: true, amount: true, reason: true, createdAt: true } }),
      this.prisma.competitionParticipant.findMany({ where: { userId }, include: { competition: { select: { title: true, type: true } } } }),
      this.prisma.prizeAward.findMany({ where: { userId }, include: { prize: { select: { title: true, kind: true } } } }),
      this.prisma.certificate.findMany({ where: { userId }, select: { kind: true, title: true, subjectName: true, rank: true, verificationCode: true, createdAt: true } }),
      this.prisma.rewardRedemption.findMany({ where: { userId }, select: { title: true, coinCost: true, status: true, createdAt: true } }),
      this.prisma.tutorSession.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100, include: { messages: { orderBy: { createdAt: 'asc' }, select: { role: true, content: true, createdAt: true } } } }),
      this.prisma.userAchievement.findMany({ where: { userId } }),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      note: 'This is the information EduQuest holds about you. Long histories are limited to the most recent entries.',
      profile: user,
      subjectStats: stats,
      dailyActivity: activity,
      xpAndCoinHistory: ledger,
      competitions: entries.map((e) => ({ competition: e.competition.title, type: e.competition.type, status: e.status, score: e.score, rank: e.rank, joinedAt: e.joinedAt })),
      prizes: prizes.map((p) => ({ prize: p.prize.title, kind: p.prize.kind, status: p.status, rank: p.rank, claimDetails: p.claimDetails, claimedAt: p.claimedAt, fulfilledAt: p.fulfilledAt })),
      certificates,
      rewardRedemptions: redemptions,
      achievements,
      tutorConversations: tutor.map((t) => ({ startedAt: t.createdAt, messages: t.messages })),
    };
  }
}
