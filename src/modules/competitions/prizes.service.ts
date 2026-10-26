import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrizeAwardStatus, PrizeKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClaimPrizeDto } from './dto/claim-prize.dto';

/** What a winner must supply, by kind of prize. Students are minors, so the
 *  high-value prizes also need a parent or guardian's number. */
export const CLAIM_REQUIREMENTS: Record<PrizeKind, { contactPhone: boolean; guardianPhone: boolean; note: boolean }> = {
  COINS: { contactPhone: false, guardianPhone: false, note: false },
  CERTIFICATE: { contactPhone: false, guardianPhone: false, note: false },
  AIRTIME: { contactPhone: true, guardianPhone: false, note: false },
  DATA: { contactPhone: true, guardianPhone: false, note: false },
  BOOKS: { contactPhone: true, guardianPhone: false, note: true },
  DEVICE: { contactPhone: true, guardianPhone: true, note: true },
  SCHOLARSHIP: { contactPhone: true, guardianPhone: true, note: true },
  OTHER: { contactPhone: true, guardianPhone: false, note: false },
};

/** A Nigerian mobile number: 0803..., +234803... (spaces and dashes allowed). */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  const m = /^(?:\+?234|0)([789][01]\d{8})$/.exec(digits);
  return m ? `+234${m[1]}` : null;
}

/** Statuses an award can still be closed from. */
const OPEN: PrizeAwardStatus[] = ['AWAITING_CLAIM', 'CLAIMED', 'VERIFIED'];

@Injectable()
export class PrizesService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
  ) {}

  // ─── Student ────────────────────────────────────────────────────────────────

  async mine(userId: string) {
    const rows = await this.prisma.prizeAward.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { prize: true, competition: { select: { id: true, title: true, type: true } } },
    });
    const now = Date.now();
    return rows.map((a) => ({
      id: a.id,
      competition: a.competition,
      rank: a.rank,
      prize: { title: a.prize.title, kind: a.prize.kind, coinAmount: a.prize.coinAmount },
      status: a.status,
      claimDeadline: a.claimDeadline,
      canClaim: a.status === 'AWAITING_CLAIM' && a.claimDeadline.getTime() >= now,
      requires: CLAIM_REQUIREMENTS[a.prize.kind],
      claimedAt: a.claimedAt,
      fulfilledAt: a.fulfilledAt,
      note: a.status === 'FORFEITED' || a.status === 'REJECTED' ? a.closedReason : (a.fulfilmentNote ?? null),
    }));
  }

  /** The winner supplies delivery details; an admin then verifies the win and fulfils it. */
  async claim(userId: string, awardId: string, dto: ClaimPrizeDto) {
    const a = await this.prisma.prizeAward.findFirst({ where: { id: awardId, userId }, include: { prize: true } });
    if (!a) throw new NotFoundException('Prize not found');
    if (a.status !== 'AWAITING_CLAIM') throw new ConflictException(a.status === 'CLAIMED' ? 'You already claimed this prize' : `This prize is ${a.status.toLowerCase().replace('_', ' ')}`);
    if (a.claimDeadline.getTime() < Date.now()) throw new ConflictException('The claim period for this prize has ended');

    const need = CLAIM_REQUIREMENTS[a.prize.kind];
    const details: Record<string, string> = {};
    if (need.contactPhone) {
      const p = dto.contactPhone ? normalisePhone(dto.contactPhone) : null;
      if (!p) throw new BadRequestException('Enter a valid Nigerian phone number we can reach you on, for example 0803 123 4567');
      details.contactPhone = p;
    }
    if (need.guardianPhone) {
      const p = dto.guardianPhone ? normalisePhone(dto.guardianPhone) : null;
      if (!p) throw new BadRequestException('This prize needs a parent or guardian’s phone number');
      details.guardianPhone = p;
      if (dto.guardianName?.trim()) details.guardianName = dto.guardianName.trim();
    }
    if (need.note) {
      if (!dto.note?.trim()) throw new BadRequestException('Tell us where and how to deliver this prize');
      details.note = dto.note.trim();
    }

    const r = await this.prisma.prizeAward.updateMany({
      where: { id: awardId, userId, status: 'AWAITING_CLAIM' },
      data: { status: 'CLAIMED', claimedAt: new Date(), claimDetails: details },
    });
    if (r.count === 0) throw new ConflictException('You already claimed this prize');
    return { claimed: true, status: 'CLAIMED' as const };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  async adminList(filter: { status?: PrizeAwardStatus; competitionId?: string; overdue?: boolean }) {
    const now = new Date();
    const rows = await this.prisma.prizeAward.findMany({
      where: {
        ...(filter.status && { status: filter.status }),
        ...(filter.competitionId && { competitionId: filter.competitionId }),
        ...(filter.overdue && { status: 'AWAITING_CLAIM', claimDeadline: { lt: now } }),
      },
      orderBy: [{ claimDeadline: 'asc' }],
      take: 200,
      include: {
        prize: true,
        competition: { select: { id: true, title: true } },
        user: { select: { id: true, fullName: true, email: true, phone: true, state: true, classLevel: true } },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      competition: a.competition,
      rank: a.rank,
      prize: { title: a.prize.title, kind: a.prize.kind, coinAmount: a.prize.coinAmount },
      status: a.status,
      winner: a.user,
      claimDeadline: a.claimDeadline,
      overdue: a.status === 'AWAITING_CLAIM' && a.claimDeadline < now,
      claimDetails: a.claimDetails,
      claimedAt: a.claimedAt,
      verifiedAt: a.verifiedAt,
      fulfilledAt: a.fulfilledAt,
      closedReason: a.closedReason,
      promotedFromId: a.promotedFromId,
    }));
  }

  /** Confirms the win is genuine (eligibility and the answer sheet were checked). Coin and certificate prizes need no claim first. */
  async verify(adminId: string, awardId: string) {
    const a = await this.award(awardId);
    const noDeliveryNeeded = a.prize.kind === 'COINS' || a.prize.kind === 'CERTIFICATE';
    const from: PrizeAwardStatus[] = noDeliveryNeeded ? ['AWAITING_CLAIM', 'CLAIMED'] : ['CLAIMED'];
    const r = await this.prisma.prizeAward.updateMany({
      where: { id: awardId, status: { in: from } },
      data: { status: 'VERIFIED', verifiedAt: new Date(), verifiedById: adminId },
    });
    if (r.count === 0) throw new ConflictException(noDeliveryNeeded ? 'This prize cannot be verified now' : 'The winner has to claim this prize (with delivery details) before it can be verified');
    return { status: 'VERIFIED' as const };
  }

  /** Marks the prize delivered. A coin prize pays the winner here, once, through the ledger. */
  async fulfil(adminId: string, awardId: string, note?: string) {
    const a = await this.award(awardId);
    const paid = await this.prisma.$transaction(async (tx) => {
      const r = await tx.prizeAward.updateMany({
        where: { id: awardId, status: 'VERIFIED' },
        data: { status: 'FULFILLED', fulfilledAt: new Date(), fulfilmentNote: note ?? null },
      });
      if (r.count === 0) throw new ConflictException('Only a verified prize can be fulfilled');
      if (a.prize.kind === 'COINS' && a.prize.coinAmount) {
        const g = await this.ledger.grant(
          { userId: a.userId, coins: a.prize.coinAmount, reason: 'competition_prize', key: `prize:${awardId}`, refType: 'prize_award', refId: awardId },
          tx,
        );
        return g.coins;
      }
      return 0;
    });
    await this.notifications.notify(
      a.userId,
      'prize_fulfilled',
      'Your prize is on its way',
      paid > 0 ? `${paid} coins were added to your balance.` : `${a.prize.title} has been delivered or arranged.`,
      { awardId },
    );
    return { status: 'FULFILLED' as const, coinsPaid: paid };
  }

  /** Verification failed (for example the sheet was copied). The prize can pass to the next place. */
  async reject(adminId: string, awardId: string, reason: string, promote = true) {
    return this.close(adminId, awardId, 'REJECTED', reason, promote);
  }

  /** Never claimed, or the winner cannot be reached. The prize can pass to the next place. */
  async forfeit(adminId: string, awardId: string, reason: string, promote = true) {
    return this.close(adminId, awardId, 'FORFEITED', reason, promote);
  }

  private async close(adminId: string, awardId: string, status: 'REJECTED' | 'FORFEITED', reason: string, promote: boolean) {
    const a = await this.award(awardId);
    const r = await this.prisma.prizeAward.updateMany({ where: { id: awardId, status: { in: OPEN } }, data: { status, closedReason: reason } });
    if (r.count === 0) throw new ConflictException('This prize is already closed');
    await this.notifications.notify(
      a.userId,
      status === 'FORFEITED' ? 'prize_forfeited' : 'prize_rejected',
      status === 'FORFEITED' ? 'Prize forfeited' : 'Prize not awarded',
      reason,
      { awardId },
    );
    const next = promote ? await this.passOn(a) : null;
    return { status, promotedTo: next ? { awardId: next.id, rank: next.rank, userId: next.userId } : null };
  }

  /** The next-ranked finisher with no prize inherits the vacated one. */
  private async passOn(from: { id: string; competitionId: string; prizeId: string; rank: number }) {
    const c = await this.prisma.competition.findUniqueOrThrow({ where: { id: from.competitionId }, select: { claimDeadlineDays: true, title: true } });
    const deepest = await this.prisma.prizeAward.aggregate({ where: { competitionId: from.competitionId }, _max: { rank: true } });
    const candidate = await this.prisma.competitionParticipant.findFirst({
      where: {
        competitionId: from.competitionId,
        status: 'COMPLETED',
        rank: { gt: deepest._max.rank ?? from.rank },
        // Never a student who already holds a prize here.
        user: { prizeAwards: { none: { competitionId: from.competitionId } } },
      },
      orderBy: { rank: 'asc' },
    });
    if (!candidate) return null;
    const award = await this.prisma.prizeAward
      .create({
        data: {
          competitionId: from.competitionId,
          prizeId: from.prizeId,
          userId: candidate.userId,
          rank: candidate.rank!,
          claimDeadline: new Date(Date.now() + c.claimDeadlineDays * 86_400_000),
          promotedFromId: from.id,
        },
        include: { prize: true },
      })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null; // another admin passed it on first
        throw e;
      });
    if (award) {
      await this.notifications.notify(candidate.userId, 'prize_won', `You won: ${award.prize.title}`, `A prize in ${c.title} passed to you. Claim it before ${award.claimDeadline.toDateString()}.`, { competitionId: from.competitionId, awardId: award.id });
    }
    return award;
  }

  private async award(id: string) {
    const a = await this.prisma.prizeAward.findUnique({ where: { id }, include: { prize: true } });
    if (!a) throw new NotFoundException('Prize award not found');
    return a;
  }
}
