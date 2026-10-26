import { levelForXp, levelProgress, levelTitle, MAX_LEVEL, xpToReachLevel } from './levels';

describe('level curve', () => {
  it('starts at level 1 and needs 500 XP for level 2', () => {
    expect(xpToReachLevel(1)).toBe(0);
    expect(xpToReachLevel(2)).toBe(500);
    expect(xpToReachLevel(3)).toBe(1100);
    expect(xpToReachLevel(5)).toBe(2600);
  });

  it('puts the boundary XP in the higher level', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(499)).toBe(1);
    expect(levelForXp(500)).toBe(2);
    expect(levelForXp(1099)).toBe(2);
    expect(levelForXp(1100)).toBe(3);
  });

  it('reports progress inside the current level', () => {
    expect(levelProgress(750)).toEqual({
      level: 2,
      title: 'Scholar',
      xpIntoLevel: 250,
      xpForLevel: 600,
      nextLevelAt: 1100,
      progress: 250 / 600,
    });
  });

  it('never goes below 1 or above the cap', () => {
    expect(levelForXp(-50)).toBe(1);
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_LEVEL);
    expect(levelProgress(Number.MAX_SAFE_INTEGER).progress).toBe(1);
  });

  it('names the first five levels and reuses the last name after', () => {
    expect(levelTitle(1)).toBe('Explorer');
    expect(levelTitle(5)).toBe('Legend');
    expect(levelTitle(40)).toBe('Legend');
  });

  it('matches the SQL backfill formula for the next-level threshold', () => {
    // maxXp = L*400 + 50*L*(L+1) must equal xpToReachLevel(L+1).
    for (let l = 1; l < 30; l++) expect(l * 400 + 50 * l * (l + 1)).toBe(xpToReachLevel(l + 1));
  });
});
