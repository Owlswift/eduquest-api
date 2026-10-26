import { DEFAULT_PREFERENCES, isAllowed, preferenceFor } from './notification-categories';

describe('notification categories', () => {
  const off = { studyReminders: false, competitions: false, achievements: false, push: false };

  it('lets everything through by default', () => {
    for (const t of ['streak_reminder', 'competition_open', 'level_up', 'prize_won', 'reward_fulfilled']) expect(isAllowed(t, DEFAULT_PREFERENCES)).toBe(true);
  });

  it('silences each category only by its own switch', () => {
    expect(isAllowed('streak_reminder', { ...DEFAULT_PREFERENCES, studyReminders: false })).toBe(false);
    expect(isAllowed('streak_reminder', { ...DEFAULT_PREFERENCES, competitions: false })).toBe(true);
    expect(isAllowed('competition_closing', { ...DEFAULT_PREFERENCES, competitions: false })).toBe(false);
    expect(isAllowed('level_up', { ...DEFAULT_PREFERENCES, achievements: false })).toBe(false);
  });

  it('always delivers messages about prizes, rewards and anything unknown, even with everything switched off', () => {
    for (const t of ['prize_won', 'prize_fulfilled', 'prize_forfeited', 'prize_claim_reminder', 'reward_redeemed', 'reward_fulfilled', 'reward_rejected', 'some_new_type']) {
      expect(preferenceFor(t)).toBeNull();
      expect(isAllowed(t, off)).toBe(true);
    }
  });
});
