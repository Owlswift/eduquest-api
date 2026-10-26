import {
  answerFingerprint, checkEligibility, compareEntries, effectiveStatus, legacyStatus, prizeForPosition,
  prizeRangeProblems, scoreSitting, sittingDeadline, sittingFlags,
} from './competition-rules';

const t = (iso: string) => new Date(iso);
const comp = (status: any, start = '2026-06-10T00:00:00Z', end = '2026-06-20T00:00:00Z') => ({ status, startsAt: t(start), endsAt: t(end) });

describe('effectiveStatus', () => {
  it('follows the clock for published competitions', () => {
    expect(effectiveStatus(comp('PUBLISHED'), t('2026-06-09T23:59:59Z'))).toBe('PUBLISHED');
    expect(effectiveStatus(comp('PUBLISHED'), t('2026-06-10T00:00:00Z'))).toBe('ACTIVE');
    expect(effectiveStatus(comp('PUBLISHED'), t('2026-06-19T23:59:59Z'))).toBe('ACTIVE');
    expect(effectiveStatus(comp('PUBLISHED'), t('2026-06-20T00:00:00Z'))).toBe('CLOSED');
    expect(effectiveStatus(comp('ACTIVE'), t('2026-07-01T00:00:00Z'))).toBe('CLOSED');
  });

  it('leaves admin-controlled states alone, whatever the clock says', () => {
    for (const s of ['DRAFT', 'FINALISED', 'ARCHIVED'] as const) {
      expect(effectiveStatus(comp(s), t('2026-06-15T00:00:00Z'))).toBe(s);
      expect(effectiveStatus(comp(s), t('2027-01-01T00:00:00Z'))).toBe(s);
    }
    expect(effectiveStatus(comp('CLOSED'), t('2026-06-15T00:00:00Z'))).toBe('CLOSED');
  });

  it('gives older clients upcoming / ongoing / ended', () => {
    const c = comp('PUBLISHED');
    expect(legacyStatus(c, t('2026-06-01T00:00:00Z'))).toBe('upcoming');
    expect(legacyStatus(c, t('2026-06-15T00:00:00Z'))).toBe('ongoing');
    expect(legacyStatus(c, t('2026-06-25T00:00:00Z'))).toBe('ended');
  });
});

describe('checkEligibility', () => {
  const rule = (over: any = {}) => ({ type: 'MONTHLY', classLevels: [], state: null, region: null, ...over });
  const student = (over: any = {}) => ({ classLevel: 'SS2' as any, state: 'Lagos', ...over });

  it('lets everyone into an open competition', () => {
    expect(checkEligibility(rule(), student()).eligible).toBe(true);
    expect(checkEligibility(rule(), student({ state: null })).eligible).toBe(true);
  });

  it('restricts by class level and says which', () => {
    const r = rule({ classLevels: ['SS2', 'SS3'] });
    expect(checkEligibility(r, student()).eligible).toBe(true);
    const no = checkEligibility(r, student({ classLevel: 'SS1' }));
    expect(no).toMatchObject({ eligible: false });
    expect(no.reason).toMatch(/SS2, SS3.*SS1/);
  });

  it('restricts a state competition to that state, however the state was spelled', () => {
    const r = rule({ type: 'STATE', state: 'Lagos' });
    expect(checkEligibility(r, student({ state: 'lagos' })).eligible).toBe(true);
    expect(checkEligibility(r, student({ state: 'Lagos State' })).eligible).toBe(true);
    expect(checkEligibility(r, student({ state: 'Kano' })).reason).toMatch(/representing Lagos.*Kano/);
    expect(checkEligibility(r, student({ state: null })).reason).toMatch(/Set your state/);
  });

  it('restricts a regional competition to the zone', () => {
    const r = rule({ type: 'REGIONAL', region: 'SOUTH_WEST' });
    expect(checkEligibility(r, student({ state: 'Ogun' })).eligible).toBe(true);
    expect(checkEligibility(r, student({ state: 'Kano' })).reason).toMatch(/South West/);
    expect(checkEligibility(r, student({ state: 'Abuja' })).eligible).toBe(false);
    expect(checkEligibility(r, student({ state: null })).reason).toMatch(/Set your state/);
  });

  it('applies class and place rules together', () => {
    const r = rule({ type: 'STATE', state: 'Lagos', classLevels: ['SS3'] });
    expect(checkEligibility(r, student({ classLevel: 'SS3' })).eligible).toBe(true);
    expect(checkEligibility(r, student({ classLevel: 'SS2' })).eligible).toBe(false);
  });
});

describe('scoring', () => {
  const rule = { pointsPerCorrect: 2, penaltyPerWrong: 1 };

  it('scores correct answers and subtracts the disclosed penalty', () => {
    expect(scoreSitting(7, 2, rule)).toBe(12);
    expect(scoreSitting(7, 0, { pointsPerCorrect: 1, penaltyPerWrong: 0 })).toBe(7);
  });

  it('never goes below zero', () => {
    expect(scoreSitting(1, 10, rule)).toBe(0);
  });

  it('ranks by score, then faster time, then earlier finish', () => {
    const e = (score: number, timeTakenSec: number, done: string) => ({ score, timeTakenSec, completedAt: t(done) });
    const field = [
      e(8, 300, '2026-06-12T10:00:00Z'),
      e(9, 500, '2026-06-12T10:00:00Z'),
      e(9, 400, '2026-06-12T11:00:00Z'),
      e(9, 400, '2026-06-12T09:00:00Z'),
    ];
    const sorted = [...field].sort(compareEntries);
    expect(sorted.map((x) => [x.score, x.timeTakenSec, x.completedAt.getUTCHours()])).toEqual([
      [9, 400, 9], [9, 400, 11], [9, 500, 10], [8, 300, 10],
    ]);
  });
});

describe('sitting deadline and flags', () => {
  it('is the student limit or the competition end, whichever is sooner', () => {
    const start = t('2026-06-12T10:00:00Z');
    const end = t('2026-06-12T10:20:00Z');
    expect(sittingDeadline(start, 600, end)).toEqual(t('2026-06-12T10:10:00Z'));
    expect(sittingDeadline(start, 3600, end)).toEqual(end);
    expect(sittingDeadline(start, null, end)).toEqual(end);
  });

  it('flags a sitting faster than anyone can read, but not a short one', () => {
    expect(sittingFlags(20, 30)).toEqual(['TOO_FAST']); // 1.5 s per answer
    expect(sittingFlags(20, 120)).toEqual([]);
    expect(sittingFlags(3, 1)).toEqual([]); // too few answers to judge
  });

  it('gives identical answer sheets the same fingerprint regardless of order', () => {
    const a = answerFingerprint({ q1: 'a', q2: 'b' });
    expect(a).toBe(answerFingerprint({ q2: 'b', q1: 'a' }));
    expect(a).not.toBe(answerFingerprint({ q1: 'a', q2: 'c' }));
    expect(answerFingerprint({})).toBeNull();
    expect(answerFingerprint({ q1: '' })).toBeNull();
  });
});

describe('prize ranges', () => {
  it('accepts ordered, separate ranges', () => {
    expect(prizeRangeProblems([{ positionFrom: 1, positionTo: 1 }, { positionFrom: 2, positionTo: 3 }, { positionFrom: 4, positionTo: 10 }])).toEqual([]);
  });

  it('rejects overlaps, backwards ranges and positions below 1', () => {
    expect(prizeRangeProblems([{ positionFrom: 1, positionTo: 3 }, { positionFrom: 3, positionTo: 5 }])[0]).toMatch(/overlap/);
    expect(prizeRangeProblems([{ positionFrom: 4, positionTo: 2 }])[0]).toMatch(/ends before/);
    expect(prizeRangeProblems([{ positionFrom: 0, positionTo: 1 }])[0]).toMatch(/from 1/);
  });

  it('finds the prize for a finishing position', () => {
    const prizes = [{ positionFrom: 1, positionTo: 1, id: 'gold' }, { positionFrom: 2, positionTo: 3, id: 'silver' }];
    expect(prizeForPosition(prizes, 1)?.id).toBe('gold');
    expect(prizeForPosition(prizes, 3)?.id).toBe('silver');
    expect(prizeForPosition(prizes, 4)).toBeUndefined();
  });
});
