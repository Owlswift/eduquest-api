import { createHash } from 'crypto';
import { ClassLevel, CompetitionStatus, CompetitionType, Region } from '@prisma/client';
import { canonicalState } from '../../common/geo/nigerian-states';
import { REGION_LABEL, regionOfState } from '../../common/geo/regions';

/**
 * The rules of a competition as pure functions, so fairness can be tested
 * without a database (PRODUCT.md section 6).
 */

/** Seconds after a deadline in which a late request still counts (network lag). */
export const SITTING_GRACE_SEC = 30;

export interface TimedCompetition {
  status: CompetitionStatus;
  startsAt: Date;
  endsAt: Date;
}

/**
 * The status a competition has right now. DRAFT, FINALISED and ARCHIVED are
 * set by an admin; PUBLISHED, ACTIVE and CLOSED follow the clock, so a
 * competition opens and closes on time even if nothing was running.
 */
export function effectiveStatus(c: TimedCompetition, now: Date = new Date()): CompetitionStatus {
  if (c.status === 'PUBLISHED' || c.status === 'ACTIVE') {
    if (now >= c.endsAt) return 'CLOSED';
    if (now >= c.startsAt) return 'ACTIVE';
    return 'PUBLISHED';
  }
  return c.status;
}

/** The three-way status older clients understand. */
export function legacyStatus(c: { startsAt: Date; endsAt: Date }, now: Date = new Date()): 'upcoming' | 'ongoing' | 'ended' {
  if (now < c.startsAt) return 'upcoming';
  if (now > c.endsAt) return 'ended';
  return 'ongoing';
}

export interface EligibilityRule {
  type: CompetitionType;
  classLevels: ClassLevel[];
  state: string | null;
  region: Region | null;
  /** Entry is only for students a qualifier advanced (a later stage, e.g. the national final). */
  requiresQualification?: boolean;
}

export interface Eligibility {
  eligible: boolean;
  /** Why not, in words a student can act on. */
  reason?: string;
}

export function checkEligibility(
  c: EligibilityRule,
  user: { classLevel: ClassLevel; state: string | null },
  /** Whether an earlier stage has qualified this student for `c`. */
  qualified = false,
): Eligibility {
  if (c.requiresQualification && !qualified) {
    return { eligible: false, reason: 'Entry is by qualification. Finish high enough in an earlier round to take part' };
  }
  if (c.classLevels.length > 0 && !c.classLevels.includes(user.classLevel)) {
    return { eligible: false, reason: `Open to ${c.classLevels.join(', ')} students. You are in ${user.classLevel}` };
  }
  if (c.type === 'STATE' && c.state) {
    if (!user.state) return { eligible: false, reason: `Set your state in your profile to enter. This is for ${c.state}` };
    if (canonicalState(user.state) !== canonicalState(c.state)) {
      return { eligible: false, reason: `Only students representing ${c.state} can enter. You represent ${user.state}` };
    }
  }
  if (c.type === 'REGIONAL' && c.region) {
    if (!user.state) return { eligible: false, reason: `Set your state in your profile to enter. This is for the ${REGION_LABEL[c.region]} zone` };
    if (regionOfState(user.state) !== c.region) {
      return { eligible: false, reason: `Open to the ${REGION_LABEL[c.region]} zone. ${user.state} is in a different zone` };
    }
  }
  return { eligible: true };
}

export interface ScoringRule {
  pointsPerCorrect: number;
  penaltyPerWrong: number;
}

/** Points for a sitting. An unanswered question costs nothing; the total never goes below 0. */
export function scoreSitting(correct: number, wrong: number, rule: ScoringRule): number {
  return Math.max(0, correct * rule.pointsPerCorrect - wrong * rule.penaltyPerWrong);
}

export interface RankableEntry {
  score: number;
  timeTakenSec: number;
  completedAt: Date;
}

/** The published tie-break order: higher score, then faster time, then who finished first. */
export function compareEntries(a: RankableEntry, b: RankableEntry): number {
  return b.score - a.score || a.timeTakenSec - b.timeTakenSec || a.completedAt.getTime() - b.completedAt.getTime();
}

/** Short, human-readable statement of the tie-break rule, shown on the competition page. */
export const TIE_BREAK_TEXT = 'Ties are broken by the faster finishing time, then by who finished first.';

/** Fingerprint of an answer sheet, to spot two students who submitted identical sheets. */
export function answerFingerprint(answers: Record<string, string>): string | null {
  const pairs = Object.entries(answers).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b));
  if (pairs.length === 0) return null;
  return createHash('sha256').update(pairs.map(([q, v]) => `${q}:${v}`).join('|')).digest('hex').slice(0, 32);
}

/** Flags raised when a sitting is recorded. A flag asks for a human look; it is not a verdict. */
export const FLAG_TOO_FAST = 'TOO_FAST';
/** Under this many seconds per answered question is faster than anyone can read the question. */
export const MIN_SECONDS_PER_ANSWER = 2;

export function sittingFlags(answered: number, timeTakenSec: number): string[] {
  const flags: string[] = [];
  if (answered >= 5 && timeTakenSec / answered < MIN_SECONDS_PER_ANSWER) flags.push(FLAG_TOO_FAST);
  return flags;
}

/** The moment a sitting must be over: the student's own limit or the competition's end, whichever is first. */
export function sittingDeadline(startedAt: Date, timeLimitSec: number | null, endsAt: Date): Date {
  const own = timeLimitSec ? new Date(startedAt.getTime() + timeLimitSec * 1000) : endsAt;
  return own < endsAt ? own : endsAt;
}

export interface PrizeRange {
  positionFrom: number;
  positionTo: number;
}

/** Problems with a list of prize ranges (empty when valid): positive, ordered, non-overlapping. */
export function prizeRangeProblems(prizes: PrizeRange[]): string[] {
  const problems: string[] = [];
  const sorted = [...prizes].sort((a, b) => a.positionFrom - b.positionFrom);
  sorted.forEach((p, i) => {
    if (!Number.isInteger(p.positionFrom) || !Number.isInteger(p.positionTo) || p.positionFrom < 1) problems.push('Prize positions must be whole numbers from 1');
    else if (p.positionTo < p.positionFrom) problems.push(`Prize ${p.positionFrom} to ${p.positionTo} ends before it starts`);
    if (i > 0 && p.positionFrom <= sorted[i - 1].positionTo) problems.push(`Prize positions overlap at ${p.positionFrom}`);
  });
  return problems;
}

/** Which prize range a finishing position falls in, if any. */
export function prizeForPosition<T extends PrizeRange>(prizes: T[], position: number): T | undefined {
  return prizes.find((p) => position >= p.positionFrom && position <= p.positionTo);
}

/** The top `count` finishers of a ranking, best first. Ranks are already tie-broken, so this is exact. */
export function qualifiersFrom<T extends { rank: number }>(ranked: T[], count: number): T[] {
  return [...ranked].sort((a, b) => a.rank - b.rank).slice(0, Math.max(0, count));
}

export interface StageRule {
  id: string;
  status: CompetitionStatus;
  startsAt: Date;
  endsAt: Date;
  nextStageId: string | null;
  requiresQualification: boolean;
}

/**
 * Why `from` cannot send its top finishers to `next`, in words for an admin.
 * `all` is every competition involved (to spot a loop). Empty = the link is fine.
 */
export function stageLinkProblems(from: StageRule, next: StageRule, advanceCount: number | null | undefined, all: StageRule[]): string[] {
  const problems: string[] = [];
  if (next.id === from.id) return ['A competition cannot lead into itself'];
  if (!advanceCount || advanceCount < 1) problems.push('Say how many top finishers advance');
  if (!next.requiresQualification) problems.push('The next stage must be set to entry by qualification, or anyone could enter it');
  if (!['DRAFT', 'PUBLISHED'].includes(next.status)) problems.push('The next stage has already started, so it can no longer take qualifiers');
  if (next.startsAt < from.endsAt) problems.push('The next stage must start after this one ends');
  // Walk forward from `next`: reaching `from` again would make a loop.
  const byId = new Map(all.map((c) => [c.id, c]));
  const seen = new Set<string>();
  for (let cur: StageRule | undefined = next; cur && !seen.has(cur.id); cur = cur.nextStageId ? byId.get(cur.nextStageId) : undefined) {
    if (cur.nextStageId === from.id) {
      problems.push('That would make the stages loop back on themselves');
      break;
    }
    seen.add(cur.id);
  }
  return problems;
}

// ─── Points league ────────────────────────────────────────────────────────────

export interface LeagueRule {
  pointsPerQuiz: number | null;
  dailyPointsCap: number | null;
  minQuestionsPerQuiz: number;
  /** Empty = every subject counts. */
  subjectIds: string[];
}

/** Whether a finished quiz counts towards a league: long enough, and in one of its subjects. */
export function quizCountsForLeague(c: LeagueRule, quiz: { questionCount: number; subjectIds: string[] }): boolean {
  if (!c.pointsPerQuiz) return false;
  if (quiz.questionCount < c.minQuestionsPerQuiz) return false;
  return c.subjectIds.length === 0 || quiz.subjectIds.some((s) => c.subjectIds.includes(s));
}

/** Points a quiz earns given what the student already earned today: the fixed amount, trimmed to the room left under the daily maximum. */
export function leagueAward(c: Pick<LeagueRule, 'pointsPerQuiz' | 'dailyPointsCap'>, earnedToday: number): number {
  const per = c.pointsPerQuiz ?? 0;
  if (c.dailyPointsCap == null) return per;
  return Math.max(0, Math.min(per, c.dailyPointsCap - earnedToday));
}

export const LEAGUE_TIE_BREAK_TEXT = 'Every point counts. If two students have the same total, the one who reached it first ranks higher.';
