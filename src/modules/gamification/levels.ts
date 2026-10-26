/**
 * The XP-to-level curve.
 *
 * Going from level L to L+1 takes `400 + 100 * L` XP (level 1 -> 2 is 500,
 * the old fixed `maxXp`), so the total XP at which level L begins is
 *   threshold(L) = (L - 1) * 400 + 50 * (L - 1) * L
 * i.e. 0, 500, 1100, 1800, 2600, ... The same formula is used by the SQL
 * backfill in the `add_levels_attempts_achievements` migration; keep them in
 * step. Levels are a progression display only and never decide competition
 * winners (PRODUCT.md section 8.2).
 */
export const MAX_LEVEL = 100;

/** Display names for the first levels; later levels keep the last name. */
export const LEVEL_TITLES = ['Explorer', 'Scholar', 'Achiever', 'Champion', 'Legend'];

export function xpToReachLevel(level: number): number {
  const l = Math.max(1, Math.min(level, MAX_LEVEL));
  return (l - 1) * 400 + 50 * (l - 1) * l;
}

export function levelTitle(level: number): string {
  return LEVEL_TITLES[Math.min(level, LEVEL_TITLES.length) - 1] ?? LEVEL_TITLES[0];
}

export interface LevelProgress {
  level: number;
  title: string;
  /** XP earned inside the current level. */
  xpIntoLevel: number;
  /** XP the current level spans (what it takes to reach the next). 0 at max level. */
  xpForLevel: number;
  /** Total XP at which the next level starts (the `maxXp` column). Equal to total XP's level start at max level. */
  nextLevelAt: number;
  /** 0 to 1 progress through the current level. */
  progress: number;
}

export function levelForXp(xp: number): number {
  const total = Math.max(0, Math.floor(xp));
  let level = 1;
  while (level < MAX_LEVEL && total >= xpToReachLevel(level + 1)) level += 1;
  return level;
}

export function levelProgress(xp: number): LevelProgress {
  const total = Math.max(0, Math.floor(xp));
  const level = levelForXp(total);
  const start = xpToReachLevel(level);
  if (level >= MAX_LEVEL) {
    return { level, title: levelTitle(level), xpIntoLevel: total - start, xpForLevel: 0, nextLevelAt: start, progress: 1 };
  }
  const next = xpToReachLevel(level + 1);
  return {
    level,
    title: levelTitle(level),
    xpIntoLevel: total - start,
    xpForLevel: next - start,
    nextLevelAt: next,
    progress: (total - start) / (next - start),
  };
}
