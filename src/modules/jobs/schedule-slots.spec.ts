import { DAILY_LATENESS_MS, latestSlot } from './schedule-slots';

const daily = (h: number) => ({ pattern: `0 ${h} * * *` });

describe('latestSlot', () => {
  it('buckets interval tasks into fixed windows', () => {
    const a = latestSlot({ everyMs: 300_000 }, new Date('2026-10-26T10:02:10Z'))!;
    const b = latestSlot({ everyMs: 300_000 }, new Date('2026-10-26T10:04:59Z'))!;
    const c = latestSlot({ everyMs: 300_000 }, new Date('2026-10-26T10:05:00Z'))!;
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
    expect(a.at.toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });

  it('runs a daily task at the Lagos hour (UTC+1)', () => {
    const s = latestSlot(daily(7), new Date('2026-10-26T06:30:00Z'))!; // 07:30 Lagos
    expect(s.at.toISOString()).toBe('2026-10-26T06:00:00.000Z');
    expect(s.key).toBe('2026-10-26T07:00+01:00');
  });

  it('has no slot before the hour on the first day, falls back to yesterday only inside the window', () => {
    // 05:30 Lagos: today's 07:00 slot hasn't happened; yesterday's was >3h ago.
    expect(latestSlot(daily(7), new Date('2026-10-26T04:30:00Z'))).toBeNull();
    // 01:30 Lagos for an 23:00 task: yesterday's slot was 2.5h ago, still on time.
    const s = latestSlot(daily(23), new Date('2026-10-26T00:30:00Z'))!;
    expect(s.key).toBe('2026-10-25T23:00+01:00');
  });

  it('skips a daily task that is later than the lateness window', () => {
    expect(latestSlot(daily(7), new Date(Date.parse('2026-10-26T06:00:00Z') + DAILY_LATENESS_MS + 1))).toBeNull();
    expect(latestSlot(daily(7), new Date(Date.parse('2026-10-26T06:00:00Z') + DAILY_LATENESS_MS))).not.toBeNull();
  });

  it('uses the Lagos calendar day, not the UTC one', () => {
    // 23:30 UTC on the 25th is 00:30 on the 26th in Lagos, so the 26th's slots apply.
    const s = latestSlot(daily(0), new Date('2026-10-25T23:30:00Z'))!;
    expect(s.key).toBe('2026-10-26T00:00+01:00');
  });

  it('rejects patterns it cannot honour rather than guessing', () => {
    expect(() => latestSlot({ pattern: '*/5 * * * *' }, new Date())).toThrow(/Unsupported/);
  });
});
