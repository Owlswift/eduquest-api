import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttemptSource, ChallengeStatus, ClassLevel } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AchievementsService } from '../gamification/achievements.service';
import { LedgerService } from '../ledger/ledger.service';
import { AttemptsService } from '../progress/attempts.service';

const DEFAULT_QUESTION_COUNT = 15;
// Same rate as a regular quiz submission (see QuizService.submitQuizResults)
// so a challenge answer is worth the same as answering it any other way.
const XP_PER_CORRECT = 10;
const COINS_PER_CORRECT = 10;
// On top of the above, whoever has the higher score once both players
// have submitted gets a modest bonus - a draw gets neither side a bonus.
const WIN_BONUS_XP = 50;
const WIN_BONUS_COINS = 20;

// Matchmaking tuning (see suggestOpponents).
const MIN_QUESTIONS_FOR_ABILITY = 5; // below this, a student's ability is "unknown" (shown as "New")
const SUGGESTION_POOL_SIZE = 300; // candidates considered before ranking - bounds query cost
const RECOMMENDED_COUNT = 5;
const DISCOVER_POOL_SIZE = 40; // "Discover" is sampled from ranks 6..40, not just the next 5
const DISCOVER_COUNT = 5;
const RECENT_TOPICS_PER_USER = 8; // how many past challenges' topic picks count toward "recent topics"
const ABILITY_WEIGHT = 0.5;
const TOPIC_WEIGHT = 0.3;
const ACTIVITY_WEIGHT = 0.2;
const SCORE_JITTER = 0.1; // +/- half this, so ranking isn't perfectly deterministic run to run

// Deterministic per-user handles for the matchmaking list, so a
// stranger's real name isn't shown before a challenge exists between
// them - same "word + number" every time, generated from their id
// rather than stored anywhere.
const PSEUDONYM_WORDS = [
  'Nova', 'Comet', 'Blaze', 'Atlas', 'Quartz', 'Zenith', 'Vertex', 'Orbit',
  'Pulsar', 'Ember', 'Cipher', 'Falcon', 'Lynx', 'Raptor', 'Nimbus', 'Vector',
  'Photon', 'Aurora', 'Draco', 'Wren', 'Onyx', 'Talon', 'Echo', 'Flux',
];

type Role = 'challenger' | 'opponent';

interface ScoredCandidate {
  userId: string;
  pseudonym: string;
  abilityPercent: number | null;
  activeToday: boolean;
  score: number;
}

@Injectable()
export class ChallengesService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private ledger: LedgerService,
    private attempts: AttemptsService,
    private achievements: AchievementsService,
  ) {}

  // ─── POST /challenges ───────────────────────────────────────────────────────

  async create(
    challengerId: string,
    dto: { opponentId: string; subjectId: string; topics: string[] },
  ) {
    if (dto.opponentId === challengerId) {
      throw new BadRequestException("You can't challenge yourself");
    }

    const [subject, opponent, challenger] = await Promise.all([
      this.prisma.subject.findUnique({ where: { id: dto.subjectId } }),
      this.prisma.user.findUnique({
        where: { id: dto.opponentId },
        select: { id: true, fullName: true, role: true, classLevel: true },
      }),
      this.prisma.user.findUnique({
        where: { id: challengerId },
        select: { fullName: true, classLevel: true },
      }),
    ]);
    if (!subject) throw new NotFoundException('Subject not found');
    if (!opponent || opponent.role !== 'STUDENT') {
      throw new NotFoundException('Opponent not found');
    }
    // Enforced here regardless of how opponentId arrived (a suggestion,
    // a search result, or crafted directly) - the client isn't trusted
    // to have already checked eligibility.
    if (opponent.classLevel !== challenger!.classLevel) {
      throw new BadRequestException('You can only challenge students in your own class level');
    }
    const openChallenge = await this.prisma.challenge.findFirst({
      where: {
        subjectId: dto.subjectId,
        status: { in: [ChallengeStatus.PENDING, ChallengeStatus.ACTIVE] },
        OR: [
          { challengerId, opponentId: dto.opponentId },
          { challengerId: dto.opponentId, opponentId: challengerId },
        ],
      },
      select: { id: true },
    });
    if (openChallenge) {
      throw new BadRequestException('You already have an open challenge with this student for this subject');
    }

    const challenge = await this.prisma.challenge.create({
      data: {
        subjectId: dto.subjectId,
        classLevel: challenger!.classLevel,
        challengerId,
        opponentId: dto.opponentId,
        challengerTopics: dto.topics ?? [],
      },
    });

    await this.notifications.notify(
      dto.opponentId,
      'challenge_received',
      '⚔️ New challenge!',
      `${this._firstName(challenger!.fullName)} challenged you to a ${subject.name} challenge!`,
      { challengeId: challenge.id },
    );

    return { id: challenge.id, status: challenge.status };
  }

  // ─── GET /challenges/suggestions ────────────────────────────────────────────

  /** Ranks candidate opponents for a subject instead of just listing
   *  everyone who studies it - the goal is "who'd make an interesting
   *  opponent for *this* student", not "who's the best student":
   *   - similar subject-specific ability (via SubjectStat) is the
   *     strongest signal - a 75% student isn't shown a 35% or a 99%
   *   - topic overlap (recent Challenge topic picks) nudges toward
   *     opponents who've been practicing similar ground
   *   - recent activity in the subject avoids suggesting someone who
   *     hasn't touched it in weeks
   *  "Recommended" is the top-ranked handful; "Discover" is sampled
   *  (with real randomness) from a wider band below that, so the same
   *  five people don't show up every time. Candidates are shown
   *  pseudonymously - real names only appear once a challenge actually
   *  exists between two students. Deferred for a later iteration:
   *  weighting by challenge accept/complete reliability, and learning
   *  match quality from how close past challenges actually were - both
   *  need history this feature only starts accumulating once it's live.
   */
  async suggestOpponents(userId: string, subjectId: string) {
    const subject = await this.prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) throw new NotFoundException('Subject not found');

    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { classLevel: true } });

    const [myStat, myTopics, candidates] = await Promise.all([
      this.prisma.subjectStat.findUnique({ where: { userId_subjectId: { userId, subjectId } } }),
      this._recentTopics(userId, subjectId),
      this.prisma.user.findMany({
        // Same class level only - questions are class-level-scoped, and
        // it keeps ability comparisons meaningful (a subject-specific
        // percentage isn't comparable across SS1 vs SS3 content).
        where: { id: { not: userId }, role: 'STUDENT', classLevel: me?.classLevel },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
        take: SUGGESTION_POOL_SIZE,
      }),
    ]);
    const myAbility = this._abilityOf(myStat);

    const alreadyOpenWith = await this._openChallengePartners(userId, subjectId);
    const candidateIds = candidates.map((c) => c.id).filter((id) => !alreadyOpenWith.has(id));
    const [stats, topicsByCandidate] = await Promise.all([
      this.prisma.subjectStat.findMany({ where: { userId: { in: candidateIds }, subjectId } }),
      this._recentTopicsFor(candidateIds, subjectId),
    ]);
    const statByUser = new Map(stats.map((s) => [s.userId, s]));

    const scored: ScoredCandidate[] = candidateIds.map((id) => {
      const stat = statByUser.get(id) ?? null;
      const ability = this._abilityOf(stat);
      const theirTopics = topicsByCandidate.get(id) ?? new Set<string>();

      const abilityScore = myAbility === null || ability === null ? 0.5 : 1 - Math.abs(myAbility - ability);
      const topicScore = this._jaccard(myTopics, theirTopics, 0.3);
      const activityScore = this._activityScore(stat?.lastActiveAt ?? null);
      const rawScore = abilityScore * ABILITY_WEIGHT + topicScore * TOPIC_WEIGHT + activityScore * ACTIVITY_WEIGHT;

      return {
        userId: id,
        pseudonym: this._pseudonymFor(id),
        abilityPercent: ability === null ? null : Math.round(ability * 100),
        activeToday: !!stat?.lastActiveAt && Date.now() - stat.lastActiveAt.getTime() < 24 * 60 * 60 * 1000,
        score: rawScore + (Math.random() - 0.5) * SCORE_JITTER,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const recommended = scored.slice(0, RECOMMENDED_COUNT);
    const discoverPool = scored.slice(RECOMMENDED_COUNT, DISCOVER_POOL_SIZE);
    const discover = this._shuffle(discoverPool).slice(0, DISCOVER_COUNT);

    const present = ({ userId: id, pseudonym, abilityPercent, activeToday }: ScoredCandidate) => ({
      userId: id,
      pseudonym,
      abilityPercent,
      activeToday,
    });

    return { recommended: recommended.map(present), discover: discover.map(present) };
  }

  // ─── GET /challenges ────────────────────────────────────────────────────────

  async list(userId: string, status?: string) {
    const where: any = { OR: [{ challengerId: userId }, { opponentId: userId }] };
    if (status) where.status = status;

    const challenges = await this.prisma.challenge.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        challenger: { select: { id: true, fullName: true } },
        opponent: { select: { id: true, fullName: true } },
        subject: { select: { id: true, name: true } },
      },
    });

    return challenges.map((c) => {
      const role = this._roleOf(c, userId);
      const opponentInfo = role === 'challenger' ? c.opponent : c.challenger;
      return {
        id: c.id,
        subjectId: c.subjectId,
        subjectName: c.subject.name,
        role,
        opponent: { id: opponentInfo.id, name: this._firstName(opponentInfo.fullName) },
        status: c.status,
        myTopics: role === 'challenger' ? c.challengerTopics : c.opponentTopics,
        theirTopics: role === 'challenger' ? c.opponentTopics : c.challengerTopics,
        myScore: role === 'challenger' ? c.challengerScore : c.opponentScore,
        theirScore: role === 'challenger' ? c.opponentScore : c.challengerScore,
        createdAt: c.createdAt,
        completedAt: c.completedAt,
      };
    });
  }

  // ─── GET /challenges/:id ────────────────────────────────────────────────────

  async getOne(userId: string, challengeId: string) {
    const c = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: {
        challenger: { select: { id: true, fullName: true } },
        opponent: { select: { id: true, fullName: true } },
        subject: { select: { id: true, name: true } },
      },
    });
    if (!c) throw new NotFoundException('Challenge not found');
    const role = this._roleOf(c, userId);
    const opponentInfo = role === 'challenger' ? c.opponent : c.challenger;

    return {
      id: c.id,
      subjectId: c.subjectId,
      subjectName: c.subject.name,
      classLevel: c.classLevel,
      role,
      opponent: { id: opponentInfo.id, name: this._firstName(opponentInfo.fullName) },
      status: c.status,
      challengerTopics: c.challengerTopics,
      opponentTopics: c.opponentTopics,
      questionCount: c.questionIds.length,
      myScore: role === 'challenger' ? c.challengerScore : c.opponentScore,
      theirScore: role === 'challenger' ? c.opponentScore : c.challengerScore,
      createdAt: c.createdAt,
      respondedAt: c.respondedAt,
      completedAt: c.completedAt,
    };
  }

  // ─── POST /challenges/:id/respond ───────────────────────────────────────────

  /** The opponent picks their own topics and accepts. This is the moment
   *  both players' choices are known, so it's when the combined,
   *  weighted question pool is generated and frozen for both sides. */
  async respond(userId: string, challengeId: string, topics: string[]) {
    const challenge = await this.prisma.challenge.findUnique({ where: { id: challengeId } });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.opponentId !== userId) {
      throw new ForbiddenException('Not your challenge to respond to');
    }
    if (challenge.status !== ChallengeStatus.PENDING) {
      throw new BadRequestException('This challenge already has a response');
    }

    const questionIds = await this._generateQuestionPool(
      challenge.subjectId,
      challenge.classLevel,
      challenge.challengerTopics as string[],
      topics,
    );
    const questions = await this.prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: { options: true },
    });

    await this.prisma.challenge.update({
      where: { id: challengeId },
      data: {
        opponentTopics: topics,
        questionIds,
        challengerOptionOrder: this._optionOrderMap(questions),
        opponentOptionOrder: this._optionOrderMap(questions),
        status: ChallengeStatus.ACTIVE,
        respondedAt: new Date(),
      },
    });

    const opponent = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    await this.notifications.notify(
      challenge.challengerId,
      'challenge_accepted',
      '⚔️ Challenge accepted!',
      `${this._firstName(opponent?.fullName ?? '')} accepted your challenge - go answer your questions!`,
      { challengeId },
    );

    return { status: ChallengeStatus.ACTIVE, questionCount: questionIds.length };
  }

  // ─── POST /challenges/:id/decline ───────────────────────────────────────────

  async decline(userId: string, challengeId: string) {
    const challenge = await this.prisma.challenge.findUnique({ where: { id: challengeId } });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.opponentId !== userId) {
      throw new ForbiddenException('Not your challenge to decline');
    }
    if (challenge.status !== ChallengeStatus.PENDING) {
      throw new BadRequestException('This challenge already has a response');
    }

    await this.prisma.challenge.update({
      where: { id: challengeId },
      data: { status: ChallengeStatus.DECLINED, respondedAt: new Date() },
    });

    const opponent = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    await this.notifications.notify(
      challenge.challengerId,
      'challenge_declined',
      'Challenge declined',
      `${this._firstName(opponent?.fullName ?? '')} declined your challenge.`,
      { challengeId },
    );

    return { status: ChallengeStatus.DECLINED };
  }

  // ─── GET /challenges/:id/questions ──────────────────────────────────────────

  async getQuestions(userId: string, challengeId: string) {
    const challenge = await this.prisma.challenge.findUnique({ where: { id: challengeId } });
    if (!challenge) throw new NotFoundException('Challenge not found');
    const role = this._roleOf(challenge, userId);
    if (challenge.status !== ChallengeStatus.ACTIVE) {
      throw new BadRequestException('This challenge has no questions to answer right now');
    }
    const alreadyDone =
      role === 'challenger' ? challenge.challengerCompletedAt : challenge.opponentCompletedAt;
    if (alreadyDone) {
      throw new BadRequestException('You already submitted your answers for this challenge');
    }

    const questions = await this.prisma.question.findMany({
      where: { id: { in: challenge.questionIds } },
      include: { options: true },
    });
    const byId = new Map(questions.map((q) => [q.id, q]));
    const orderMap = (
      role === 'challenger' ? challenge.challengerOptionOrder : challenge.opponentOptionOrder
    ) as Record<string, string[]>;

    // correctAnswerId is deliberately withheld - grading happens
    // server-side in submitAnswers, same anti-cheat principle as the
    // regular quiz flow.
    return challenge.questionIds.map((qid) => {
      const q = byId.get(qid)!;
      const optionById = new Map(q.options.map((o) => [o.id, o]));
      const order = orderMap[qid] ?? q.options.map((o) => o.id);
      return {
        id: q.id,
        topic: q.topic,
        questionText: q.questionText,
        explanation: q.explanation,
        difficulty: q.difficulty,
        options: order.map((oid) => ({ id: oid, text: optionById.get(oid)?.text ?? '' })),
      };
    });
  }

  // ─── POST /challenges/:id/answers ───────────────────────────────────────────

  async submitAnswers(
    userId: string,
    challengeId: string,
    answers: { questionId: string; selectedOptionId: string }[],
  ) {
    const challenge = await this.prisma.challenge.findUnique({ where: { id: challengeId } });
    if (!challenge) throw new NotFoundException('Challenge not found');
    const role = this._roleOf(challenge, userId);
    if (challenge.status !== ChallengeStatus.ACTIVE) {
      throw new BadRequestException('Challenge is not active');
    }
    const alreadyDone =
      role === 'challenger' ? challenge.challengerCompletedAt : challenge.opponentCompletedAt;
    if (alreadyDone) {
      throw new BadRequestException('You already submitted your answers for this challenge');
    }

    // Grade server-side against the real answer key - never trust a
    // client-reported score. Only the challenge's own questions count, and
    // each at most once (a repeated question id can't inflate the score).
    const questions = await this.prisma.question.findMany({
      where: { id: { in: challenge.questionIds } },
      select: { id: true, correctAnswerId: true },
    });
    const correctById = new Map(questions.map((q) => [q.id, q.correctAnswerId]));
    const picked = new Map<string, string>();
    for (const a of answers) {
      if (correctById.has(a.questionId) && !picked.has(a.questionId)) {
        picked.set(a.questionId, a.selectedOptionId);
      }
    }
    const score = [...picked].filter(([qid, opt]) => correctById.get(qid) === opt).length;
    const answersMap = Object.fromEntries(picked);

    const now = new Date();
    const mine =
      role === 'challenger'
        ? { challengerAnswers: answersMap, challengerScore: score, challengerCompletedAt: now }
        : { opponentAnswers: answersMap, opponentScore: score, opponentCompletedAt: now };

    // Claim this player's submission with a conditional write: the row only
    // matches while they haven't submitted, so a double-tap or replay loses
    // the race instead of being graded and paid twice.
    const claimed = await this.prisma.challenge.updateMany({
      where: {
        id: challengeId,
        status: ChallengeStatus.ACTIVE,
        ...(role === 'challenger' ? { challengerCompletedAt: null } : { opponentCompletedAt: null }),
      },
      data: mine,
    });
    if (claimed.count === 0) {
      throw new BadRequestException('You already submitted your answers for this challenge');
    }

    // Whoever submits second completes the challenge. Checked on the fresh
    // row (not the pre-read) so two near-simultaneous submissions still
    // finish it exactly once.
    let updated = await this.prisma.challenge.findUniqueOrThrow({ where: { id: challengeId } });
    const bothDone = !!(updated.challengerCompletedAt && updated.opponentCompletedAt);
    let finishedHere = false;
    if (bothDone) {
      const done = await this.prisma.challenge.updateMany({
        where: { id: challengeId, status: ChallengeStatus.ACTIVE },
        data: { status: ChallengeStatus.COMPLETED, completedAt: now },
      });
      finishedHere = done.count === 1;
      if (finishedHere) {
        updated = await this.prisma.challenge.findUniqueOrThrow({ where: { id: challengeId } });
      }
    }

    const earnedXp = score * XP_PER_CORRECT;
    const earnedCoins = score * COINS_PER_CORRECT;
    await this.ledger.grant({
      userId,
      xp: earnedXp,
      coins: earnedCoins,
      reason: 'challenge',
      key: `challenge:${challengeId}:${userId}`,
      refType: 'challenge',
      refId: challengeId,
    });
    await this.attempts.record(
      userId,
      AttemptSource.CHALLENGE,
      challengeId,
      challenge.questionIds.map((qid) => {
        const chosen = picked.get(qid);
        return { questionId: qid, selectedOptionId: chosen ? chosen : null, correct: chosen !== undefined && correctById.get(qid) === chosen };
      }),
    );
    // Same subject-accuracy tracking a regular quiz submission does -
    // feeds Challenge matchmaking regardless of which mode the student
    // actually answered questions through.
    await this.prisma.subjectStat.upsert({
      where: { userId_subjectId: { userId, subjectId: challenge.subjectId } },
      create: { userId, subjectId: challenge.subjectId, questionsAnswered: picked.size, correctAnswers: score },
      update: {
        questionsAnswered: { increment: picked.size },
        correctAnswers: { increment: score },
        lastActiveAt: new Date(),
      },
    });

    if (finishedHere) {
      await this._finishChallenge(updated);
      // A win may unlock an achievement for either player.
      await Promise.all([
        this.achievements.evaluate(updated.challengerId),
        this.achievements.evaluate(updated.opponentId),
      ]);
    } else {
      await this.achievements.evaluate(userId);
    }

    return {
      score,
      totalQuestions: challenge.questionIds.length,
      earnedXp,
      earnedCoins,
      waitingOnOpponent: !bothDone,
    };
  }

  // ─── GET /challenges/:id/results ────────────────────────────────────────────

  async getResults(userId: string, challengeId: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: {
        challenger: { select: { id: true, fullName: true } },
        opponent: { select: { id: true, fullName: true } },
      },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    this._roleOf(challenge, userId);
    if (challenge.status !== ChallengeStatus.COMPLETED) {
      throw new BadRequestException('This challenge is not finished yet');
    }

    const cScore = challenge.challengerScore ?? 0;
    const oScore = challenge.opponentScore ?? 0;
    const total = challenge.questionIds.length;
    const winner: Role | null = cScore === oScore ? null : cScore > oScore ? 'challenger' : 'opponent';

    const summarize = (score: number, isWinner: boolean) => ({
      correctCount: score,
      totalQuestions: total,
      earnedXp: score * XP_PER_CORRECT + (isWinner ? WIN_BONUS_XP : 0),
      earnedCoins: score * COINS_PER_CORRECT + (isWinner ? WIN_BONUS_COINS : 0),
    });

    return {
      subjectId: challenge.subjectId,
      completedAt: challenge.completedAt,
      isDraw: winner === null,
      challenger: {
        id: challenge.challenger.id,
        name: this._firstName(challenge.challenger.fullName),
        won: winner === 'challenger',
        ...summarize(cScore, winner === 'challenger'),
      },
      opponent: {
        id: challenge.opponent.id,
        name: this._firstName(challenge.opponent.fullName),
        won: winner === 'opponent',
        ...summarize(oScore, winner === 'opponent'),
      },
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async _finishChallenge(challenge: {
    id: string;
    challengerId: string;
    opponentId: string;
    challengerScore: number | null;
    opponentScore: number | null;
  }) {
    const cScore = challenge.challengerScore ?? 0;
    const oScore = challenge.opponentScore ?? 0;
    const winnerId =
      cScore === oScore ? null : cScore > oScore ? challenge.challengerId : challenge.opponentId;

    if (winnerId) {
      await this.ledger.grant({
        userId: winnerId,
        xp: WIN_BONUS_XP,
        coins: WIN_BONUS_COINS,
        reason: 'challenge_win',
        key: `challenge_win:${challenge.id}`,
        refType: 'challenge',
        refId: challenge.id,
      });
    }

    const [challenger, opponent] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: challenge.challengerId },
        select: { fullName: true },
      }),
      this.prisma.user.findUnique({
        where: { id: challenge.opponentId },
        select: { fullName: true },
      }),
    ]);
    const cName = this._firstName(challenger?.fullName ?? '');
    const oName = this._firstName(opponent?.fullName ?? '');

    const messageFor = (won: boolean, isDraw: boolean, opponentName: string, my: number, their: number) => {
      if (isDraw) return { title: '🤝 Challenge tied!', body: `You and ${opponentName} tied ${my}-${their}.` };
      if (won) return { title: '🎉 You won your challenge!', body: `You beat ${opponentName} ${my}-${their}!` };
      return { title: 'Challenge complete', body: `${opponentName} beat you ${their}-${my}. Rematch?` };
    };

    const isDraw = winnerId === null;
    const challengerMsg = messageFor(winnerId === challenge.challengerId, isDraw, oName, cScore, oScore);
    const opponentMsg = messageFor(winnerId === challenge.opponentId, isDraw, cName, oScore, cScore);

    await Promise.all([
      this.notifications.notify(challenge.challengerId, 'challenge_completed', challengerMsg.title, challengerMsg.body, {
        challengeId: challenge.id,
      }),
      this.notifications.notify(challenge.opponentId, 'challenge_completed', opponentMsg.title, opponentMsg.body, {
        challengeId: challenge.id,
      }),
    ]);
  }

  /** Every userId `userId` already has a PENDING or ACTIVE challenge with,
   *  for this subject - used to keep matchmaking/search from suggesting
   *  someone you can't actually challenge right now (create() enforces
   *  the same rule; this just keeps the suggestion list from dangling
   *  a pick that would immediately fail). */
  private async _openChallengePartners(userId: string, subjectId: string): Promise<Set<string>> {
    const rows = await this.prisma.challenge.findMany({
      where: {
        subjectId,
        status: { in: [ChallengeStatus.PENDING, ChallengeStatus.ACTIVE] },
        OR: [{ challengerId: userId }, { opponentId: userId }],
      },
      select: { challengerId: true, opponentId: true },
    });
    return new Set(rows.map((r) => (r.challengerId === userId ? r.opponentId : r.challengerId)));
  }

  private _abilityOf(stat: { questionsAnswered: number; correctAnswers: number } | null): number | null {
    if (!stat || stat.questionsAnswered < MIN_QUESTIONS_FOR_ABILITY) return null;
    return stat.correctAnswers / stat.questionsAnswered;
  }

  /** Topics `userId` has picked in their last few challenges for this
   *  subject (as either side) - a cheap proxy for "what they've
   *  recently been practicing" that reuses data Challenges already
   *  stores, rather than needing new per-topic attempt tracking. */
  private async _recentTopics(
    userId: string,
    subjectId: string,
    limit: number = RECENT_TOPICS_PER_USER,
  ): Promise<Set<string>> {
    const rows = await this.prisma.challenge.findMany({
      where: { subjectId, OR: [{ challengerId: userId }, { opponentId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { challengerId: true, challengerTopics: true, opponentTopics: true },
    });
    const set = new Set<string>();
    for (const r of rows) {
      const topics = (r.challengerId === userId ? r.challengerTopics : r.opponentTopics) as
        | string[]
        | null;
      (topics ?? []).forEach((t) => set.add(t));
    }
    return set;
  }

  /** Same as [_recentTopics], batched for a whole candidate pool in one
   *  query instead of one round trip per candidate. */
  private async _recentTopicsFor(
    candidateIds: string[],
    subjectId: string,
  ): Promise<Map<string, Set<string>>> {
    const idSet = new Set(candidateIds);
    const rows = await this.prisma.challenge.findMany({
      where: {
        subjectId,
        OR: [{ challengerId: { in: candidateIds } }, { opponentId: { in: candidateIds } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { challengerId: true, opponentId: true, challengerTopics: true, opponentTopics: true },
    });

    const perUserCount = new Map<string, number>();
    const result = new Map<string, Set<string>>();
    for (const r of rows) {
      const sides: [string, string[] | null][] = [
        [r.challengerId, r.challengerTopics as string[] | null],
        [r.opponentId, r.opponentTopics as string[] | null],
      ];
      for (const [uid, topics] of sides) {
        if (!idSet.has(uid)) continue;
        const count = perUserCount.get(uid) ?? 0;
        if (count >= RECENT_TOPICS_PER_USER) continue;
        perUserCount.set(uid, count + 1);
        const set = result.get(uid) ?? new Set<string>();
        (topics ?? []).forEach((t) => set.add(t));
        result.set(uid, set);
      }
    }
    return result;
  }

  private _jaccard(a: Set<string>, b: Set<string>, neutralIfEitherEmpty: number): number {
    if (a.size === 0 || b.size === 0) return neutralIfEitherEmpty;
    let intersection = 0;
    for (const t of a) if (b.has(t)) intersection++;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? neutralIfEitherEmpty : intersection / union;
  }

  private _activityScore(lastActiveAt: Date | null): number {
    if (!lastActiveAt) return 0.2;
    const days = (Date.now() - lastActiveAt.getTime()) / 86_400_000;
    if (days <= 1) return 1;
    if (days <= 3) return 0.7;
    if (days <= 7) return 0.4;
    return 0.1;
  }

  private _pseudonymFor(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    }
    const word = PSEUDONYM_WORDS[hash % PSEUDONYM_WORDS.length];
    const number = (hash % 900) + 100;
    return `${word}${number}`;
  }

  private _roleOf(challenge: { challengerId: string; opponentId: string }, userId: string): Role {
    if (challenge.challengerId === userId) return 'challenger';
    if (challenge.opponentId === userId) return 'opponent';
    throw new ForbiddenException('Not a participant in this challenge');
  }

  private _firstName(fullName: string): string {
    const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
    if (!first) return 'Student';
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  private _shuffle<T>(arr: T[]): T[] {
    return [...arr].sort(() => Math.random() - 0.5);
  }

  /** Builds the frozen, weighted question pool for a challenge: topics
   *  both players picked get double the representation of topics only
   *  one of them picked. Falls back to a plain random subject pool if
   *  neither player picked any topics (or the subject has none tagged),
   *  and tops up from the wider subject pool if the tagged topics alone
   *  don't have enough questions to reach `count`. */
  private async _generateQuestionPool(
    subjectId: string,
    classLevel: ClassLevel,
    challengerTopics: string[],
    opponentTopics: string[],
    count: number = DEFAULT_QUESTION_COUNT,
  ): Promise<string[]> {
    const setA = new Set(challengerTopics);
    const setB = new Set(opponentTopics);
    const combined = [...new Set([...setA, ...setB])];

    if (combined.length === 0) {
      const all = await this.prisma.question.findMany({
        where: { subjectId, classLevel },
        select: { id: true },
      });
      return this._shuffle(all.map((q) => q.id)).slice(0, count);
    }

    const weights: Record<string, number> = {};
    for (const t of combined) weights[t] = setA.has(t) && setB.has(t) ? 2 : 1;

    const available: Record<string, string[]> = {};
    for (const t of combined) {
      const qs = await this.prisma.question.findMany({
        where: { subjectId, classLevel, topic: t },
        select: { id: true },
      });
      available[t] = this._shuffle(qs.map((q) => q.id));
    }

    const allocation = this._allocateCounts(
      weights,
      count,
      Object.fromEntries(combined.map((t) => [t, available[t].length])),
    );

    let pool: string[] = [];
    for (const t of combined) pool.push(...available[t].slice(0, allocation[t] ?? 0));

    if (pool.length < count) {
      const rest = await this.prisma.question.findMany({
        where: { subjectId, classLevel, id: { notIn: pool } },
        select: { id: true },
      });
      pool.push(...this._shuffle(rest.map((q) => q.id)).slice(0, count - pool.length));
    }

    return this._shuffle(pool).slice(0, count);
  }

  /** Largest-remainder allocation of `total` slots across topics by
   *  weight, capped by how many questions each topic actually has. */
  private _allocateCounts(
    weights: Record<string, number>,
    total: number,
    available: Record<string, number>,
  ): Record<string, number> {
    const topics = Object.keys(weights);
    const totalWeight = topics.reduce((s, t) => s + weights[t], 0);

    const exact = new Map(topics.map((t) => [t, (weights[t] / totalWeight) * total]));
    const alloc: Record<string, number> = {};
    let assigned = 0;
    for (const t of topics) {
      const capped = Math.min(Math.floor(exact.get(t)!), available[t] ?? 0);
      alloc[t] = capped;
      assigned += capped;
    }

    let remaining = total - assigned;
    const byRemainder = [...topics].sort(
      (a, b) => (exact.get(b)! - Math.floor(exact.get(b)!)) - (exact.get(a)! - Math.floor(exact.get(a)!)),
    );

    while (remaining > 0) {
      let progressed = false;
      for (const t of byRemainder) {
        if (remaining <= 0) break;
        if (alloc[t] < (available[t] ?? 0)) {
          alloc[t]++;
          remaining--;
          progressed = true;
        }
      }
      if (!progressed) break; // no topic has any room left
    }

    return alloc;
  }

  private _optionOrderMap(
    questions: { id: string; options: { id: string }[] }[],
  ): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const q of questions) map[q.id] = this._shuffle(q.options.map((o) => o.id));
    return map;
  }
}
