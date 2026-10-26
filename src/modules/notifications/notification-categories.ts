/**
 * Which setting governs each notification type. A type that is not listed is
 * treated as transactional and always delivered: a message about a student's
 * money or prize must never be silenced by an unrelated switch.
 */
export type PreferenceKey = 'studyReminders' | 'competitions' | 'achievements';

export const NOTIFICATION_CATEGORY: Record<string, PreferenceKey> = {
  // Study habits.
  streak_reminder: 'studyReminders',
  daily_challenge_ready: 'studyReminders',
  // Competitions (not prizes: those are about winnings).
  competition_joined: 'competitions',
  competition_open: 'competitions',
  competition_closing: 'competitions',
  competition_results: 'competitions',
  // Progress and recognition.
  achievement_unlocked: 'achievements',
  level_up: 'achievements',
  certificate_earned: 'achievements',
  welcome_bonus: 'achievements',
  badge_earned: 'achievements',
};

export function preferenceFor(type: string): PreferenceKey | null {
  return NOTIFICATION_CATEGORY[type] ?? null;
}

export interface Preferences {
  studyReminders: boolean;
  competitions: boolean;
  achievements: boolean;
  push: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { studyReminders: true, competitions: true, achievements: true, push: true };

/** Whether a notification of `type` may be created for someone with these preferences. */
export function isAllowed(type: string, prefs: Preferences): boolean {
  const key = preferenceFor(type);
  return key === null || prefs[key];
}
