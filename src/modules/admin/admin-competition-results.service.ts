import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { publicName } from '../../common/names';
import { PrismaService } from '../../database/prisma.service';
import { CertificatesService } from '../certificates/certificates.service';
import { effectiveStatus, prizeForPosition } from '../competitions/competition-rules';
import { AchievementsService } from '../gamification/achievements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { QuizService } from '../quiz/quiz.service';
import { AuditService } from './audit.service';

export const FLAG_SAME_ANSWERS = 'SAME_ANSWERS';
/** Identical sheets only matter when they share this many wrong answers: identical perfect sheets are normal. */
export const SAME_ANSWERS_MIN_WRONG = 3;

type PrizeRow = { id: string; positionFrom: number; positionTo: number; title: string; kind: string };

@Injectable()
export class AdminCompetitionResultsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private quiz: QuizService,
    private notifications: NotificationsService,
    private achievements: AchievementsService,
  ) {}

  // ─── Entries and validation ─────────────────────────────────────────────────

  /** Every entry with what an admin needs to judge it: score, time, flags, and
   *  how many other sheets are identical. Best first; people who did not finish last. */
  async entries(competitionId: string) {
    await this.load(competitionId);
    const rows = await this.prisma.$queryRaw<
      {
        userId: string; fullName: string; email: string; phone: string | null; state: string | null; classLevel: string;
        status: string; score: number | null; correct: number | null; wrong: number | null; time: number | null;
        completedAt: Date | null; rank: number | null; flags: string[]; reason: string | null; same: number; pos: number | null;
      }[]
    >(Prisma.sql`
      SELECT p."userId", u."fullName", u."email", u."phone", u."state", u."classLevel"::text AS "classLevel",
             p."status"::text AS status, p."score", p."correctCount" AS correct, p."wrongCount" AS wrong,
             p."timeTakenSec" AS time, p."completedAt", p."rank", p."flags", p."disqualifiedReason" AS reason,
             CASE WHEN p."answerHash" IS NULL THEN 0
                  ELSE (SELECT count(*)::int - 1 FROM "CompetitionParticipant" o
                         WHERE o."competitionId" = p."competitionId" AND o."answerHash" = p."answerHash") END AS same,
             CASE WHEN p."status" = 'COMPLETED'
                  THEN (ROW_NUMBER() OVER (PARTITION BY p."status" ORDER BY p."score" DESC, p."timeTakenSec" ASC, p."completedAt" ASC))::int END AS pos
        FROM "CompetitionParticipant" p JOIN "User" u ON u."id" = p."userId"
       WHERE p."competitionId" = ${competitionId}
       ORDER BY (p."status" = 'COMPLETED') DESC, p."score" DESC NULLS LAST, p."timeTakenSec" ASC NULLS LAST, p."joinedAt" ASC`);
    return rows.map((r) => ({
      userId: r.userId,
      name: publicName(r.fullName),
      fullName: r.fullName,
      email: r.email,
      phone: r.phone,
      state: r.state,
      classLevel: r.classLevel,
      status: r.status,
      position: r.pos,
      rank: r.rank,
      score: r.score,
      correctCount: r.correct,
      wrongCount: r.wrong,
      timeTakenSec: r.time,
      completedAt: r.completedAt,
      flags: r.flags,
      identicalSheets: r.same,
      disqualifiedReason: r.reason,
    }));
  }

  /**
   * Prepares a closed competition for finalising: grades sittings that were
   * never submitted from the answers locked in time, and flags groups of
   * entries that handed in the same answer sheet with several wrong answers
   * in common. Flags ask for a human decision; they disqualify nobody.
   */
  async validate(adminId: string, competitionId: string) {
    const c = await this.load(competitionId);
    if (c.status !== 'CLOSED') throw new ConflictException('Validation runs on a closed competition that has not been finalised');

    const settled = await this.settleOpenSittings(competitionId);
    const flagged = await this.flagIdenticalSheets(competitionId);
    await this.audit.log({
      adminId,
      action: 'competition.validate',
      entityType: 'competition',
      entityId: competitionId,
      summary: `Validated: ${settled} unsubmitted sittings graded, ${flagged} entries flagged for identical answers`,
    });
    const entries = await this.entries(competitionId);
    return {
      settledSittings: settled,
      newlyFlagged: flagged,
      completed: entries.filter((e) => e.status === 'COMPLETED').length,
      needsReview: entries.filter((e) => e.status === 'COMPLETED' && e.flags.length > 0),
    };
  }

  private async settleOpenSittings(competitionId: string): Promise<number> {
    const open = await this.prisma.quizSession.findMany({
      where: { competitionId, status: 'OPEN' },
      select: { id: true, userId: true },
    });
    let n = 0;
    for (const s of open) {
      try {
        await this.quiz.settleCompetitionSession(s.userId, s.id);
        n += 1;
      } catch {
        // Someone submitted at the same moment: already graded, nothing to do.
      }
    }
    return n;
  }

  private async flagIdenticalSheets(competitionId: string): Promise<number> {
    const res = await this.prisma.$executeRaw`
      UPDATE "CompetitionParticipant" p
         SET "flags" = array_append(p."flags", ${FLAG_SAME_ANSWERS})
       WHERE p."competitionId" = ${competitionId}
         AND p."status" = 'COMPLETED'
         AND p."answerHash" IS NOT NULL
         AND COALESCE(p."wrongCount", 0) >= ${SAME_ANSWERS_MIN_WRONG}
         AND NOT (${FLAG_SAME_ANSWERS} = ANY (p."flags"))
         AND (SELECT count(*) FROM "CompetitionParticipant" o
               WHERE o."competitionId" = p."competitionId" AND o."answerHash" = p."answerHash" AND o."status" = 'COMPLETED') > 1`;
    return res;
  }

  async disqualify(adminId: string, competitionId: string, userId: string, reason: string) {
    const c = await this.load(competitionId);
    if (c.status !== 'CLOSED') throw new ConflictException('Entries can only be disqualified after it closes and before results are finalised');
    const r = await this.prisma.competitionParticipant.updateMany({
      where: { competitionId, userId, status: { not: 'DISQUALIFIED' } },
      data: { status: 'DISQUALIFIED', disqualifiedReason: reason },
    });
    if (r.count === 0) throw new NotFoundException('No such entry, or it is already disqualified');
    await this.audit.log({ adminId, action: 'competition.disqualify', entityType: 'competition', entityId: competitionId, summary: `Disqualified entry ${userId}: ${reason}`, after: { userId, reason } });
    return { disqualified: true };
  }

  /** Puts a disqualified entry back (a mistaken decision). Its sitting result is untouched, so it simply competes again. */
  async reinstate(adminId: string, competitionId: string, userId: string) {
    const c = await this.load(competitionId);
    if (c.status !== 'CLOSED') throw new ConflictException('Entries can only be reinstated before results are finalised');
    const e = await this.prisma.competitionParticipant.findUnique({ where: { competitionId_userId: { competitionId, userId } } });
    if (!e || e.status !== 'DISQUALIFIED') throw new NotFoundException('That entry is not disqualified');
    await this.prisma.competitionParticipant.update({
      where: { id: e.id },
      data: { status: e.completedAt ? 'COMPLETED' : 'ENTERED', disqualifiedReason: null },
    });
    await this.audit.log({ adminId, action: 'competition.reinstate', entityType: 'competition', entityId: competitionId, summary: `Reinstated entry ${userId}`, after: { userId } });
    return { reinstated: true };
  }

  // ─── Finalise ───────────────────────────────────────────────────────────────

  /**
   * Confirms the results. Grades anything left unsubmitted, fixes the final
   * ranking (score, then faster time, then earlier finish; disqualified entries
   * excluded), creates a prize award for each winner, and issues participation
   * and winner certificates. The CLOSED -> FINALISED flip is the single gate, so
   * results are produced once however many admins click.
   */
  async finalise(adminId: string, competitionId: string) {
    const c = await this.load(competitionId);
    if (c.status === 'FINALISED' || c.status === 'ARCHIVED') throw new ConflictException('These results were already finalised');
    if (c.status !== 'CLOSED') throw new ConflictException('A competition can only be finalised after it closes');

    await this.settleOpenSittings(competitionId);
    await this.flagIdenticalSheets(competitionId);

    const finalised = await this.prisma.$transaction(async (tx) => {
      const gate = await tx.competition.updateMany({ where: { id: competitionId, status: 'CLOSED' }, data: { status: 'FINALISED', finalisedAt: new Date() } });
      if (gate.count === 0) return null;

      await tx.$executeRaw`
        UPDATE "CompetitionParticipant" p SET "rank" = r.pos
          FROM (SELECT "id", (ROW_NUMBER() OVER (ORDER BY "score" DESC, "timeTakenSec" ASC, "completedAt" ASC))::int AS pos
                  FROM "CompetitionParticipant" WHERE "competitionId" = ${competitionId} AND "status" = 'COMPLETED') r
         WHERE p."id" = r."id"`;

      const ranked = await tx.competitionParticipant.findMany({
        where: { competitionId, status: 'COMPLETED' },
        orderBy: { rank: 'asc' },
        select: { userId: true, rank: true },
      });
      const deadline = new Date(Date.now() + c.claimDeadlineDays * 86_400_000);
      const prizes = c.prizeList as PrizeRow[];
      const awards = ranked.flatMap((e) => {
        const prize = prizeForPosition(prizes, e.rank!);
        return prize ? [{ competitionId, prizeId: prize.id, userId: e.userId, rank: e.rank!, claimDeadline: deadline }] : [];
      });
      if (awards.length > 0) await tx.prizeAward.createMany({ data: awards, skipDuplicates: true });

      const certs = await this.issueCertificates(tx, c, ranked as { userId: string; rank: number }[]);
      return { ranked: ranked.length, awards: awards.length, certificates: certs };
    });
    if (!finalised) throw new ConflictException('These results were just finalised by someone else');

    await this.audit.log({
      adminId,
      action: 'competition.finalise',
      entityType: 'competition',
      entityId: competitionId,
      summary: `Finalised "${c.title}": ${finalised.ranked} ranked, ${finalised.awards} prizes, ${finalised.certificates} certificates`,
      before: { status: 'CLOSED' },
      after: { status: 'FINALISED', ...finalised },
    });
    await this.announce(competitionId, c.title);
    return { status: 'FINALISED' as const, ...finalised };
  }

  async archive(adminId: string, competitionId: string) {
    const r = await this.prisma.competition.updateMany({ where: { id: competitionId, status: 'FINALISED' }, data: { status: 'ARCHIVED' } });
    if (r.count === 0) throw new ConflictException('Only finalised competitions can be archived');
    await this.audit.log({ adminId, action: 'competition.archive', entityType: 'competition', entityId: competitionId, summary: 'Archived', before: { status: 'FINALISED' }, after: { status: 'ARCHIVED' } });
    return { status: 'ARCHIVED' as const };
  }

  // ─── Certificates and announcements ─────────────────────────────────────────

  /** Participation for everyone who finished; a winner certificate (with the
   *  place, and the champion title for rank 1 of a state, regional or national
   *  competition) for the top three. */
  private async issueCertificates(tx: Prisma.TransactionClient, c: { id: string; title: string; type: string; state: string | null; region: string | null }, ranked: { userId: string; rank: number }[]) {
    const champion: Record<string, string> = {
      STATE: `${c.state ?? ''} State Champion`.trim(),
      REGIONAL: 'Regional Champion',
      NATIONAL: 'National Champion',
    };
    const winnerTitle = (rank: number) =>
      rank === 1 ? (champion[c.type] ?? 'Winner') : rank === 2 ? 'Runner-up' : 'Third place';

    const rows: Prisma.CertificateCreateManyInput[] = [];
    for (const e of ranked) {
      rows.push({ userId: e.userId, kind: 'PARTICIPATION', competitionId: c.id, subjectName: c.title, title: 'Participant', verificationCode: CertificatesService.newCode() });
      if (e.rank <= 3) {
        rows.push({ userId: e.userId, kind: 'WINNER', competitionId: c.id, rank: e.rank, subjectName: c.title, title: winnerTitle(e.rank), verificationCode: CertificatesService.newCode() });
      }
    }
    if (rows.length === 0) return 0;
    let created = 0;
    // A (practically impossible) code clash would be skipped silently by ON CONFLICT, so retry the stragglers.
    for (let attempt = 0; attempt < 3 && rows.length > 0; attempt++) {
      created += (await tx.certificate.createMany({ data: rows, skipDuplicates: true })).count;
      const have = await tx.certificate.findMany({ where: { competitionId: c.id }, select: { userId: true, kind: true } });
      const done = new Set(have.map((h) => `${h.userId}:${h.kind}`));
      const missing = rows.filter((r) => !done.has(`${r.userId}:${r.kind}`));
      rows.length = 0;
      for (const m of missing) rows.push({ ...m, verificationCode: CertificatesService.newCode() });
    }
    // `User.certificates` counts every certificate: everyone gets a participation one, the podium a second.
    await tx.user.updateMany({ where: { id: { in: ranked.map((r) => r.userId) } }, data: { certificates: { increment: 1 } } });
    const podium = ranked.filter((r) => r.rank <= 3).map((r) => r.userId);
    if (podium.length > 0) await tx.user.updateMany({ where: { id: { in: podium } }, data: { certificates: { increment: 1 } } });
    return created;
  }

  private async announce(competitionId: string, title: string) {
    const [entries, awards] = await Promise.all([
      this.prisma.competitionParticipant.findMany({ where: { competitionId, status: 'COMPLETED' }, select: { userId: true, rank: true } }),
      this.prisma.prizeAward.findMany({ where: { competitionId }, include: { prize: true } }),
    ]);
    const won = new Map(awards.map((a) => [a.userId, a]));
    for (const e of entries) {
      const prize = won.get(e.userId);
      if (prize) {
        await this.notifications.notify(e.userId, 'prize_won', `You won: ${prize.prize.title}`, `You finished ${ordinal(e.rank!)} in ${title}. Claim your prize before ${prize.claimDeadline.toDateString()}.`, { competitionId, awardId: prize.id });
      } else {
        await this.notifications.notify(e.userId, 'competition_results', `${title}: results are in`, `You finished ${ordinal(e.rank!)}. See how you did.`, { competitionId });
      }
    }
    // The podium may unlock Top Finisher; everyone who finished may unlock Competitor.
    for (const e of entries) await this.achievements.evaluate(e.userId);
  }

  private async load(id: string) {
    const c = await this.prisma.competition.findUnique({ where: { id }, include: { prizeList: true } });
    if (!c) throw new NotFoundException('Competition not found');
    const next = effectiveStatus(c);
    if (next !== c.status) {
      await this.prisma.competition.updateMany({ where: { id, status: c.status }, data: { status: next } });
      c.status = next;
    }
    if (c.format !== 'FIXED_SET') throw new BadRequestException('This competition is ranked by XP earned and has no sittings to validate');
    return c;
  }
}

export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = ['th', 'st', 'nd', 'rd'][(v - 20) % 10] ?? ['th', 'st', 'nd', 'rd'][v] ?? 'th';
  return `${n}${suffix}`;
}
