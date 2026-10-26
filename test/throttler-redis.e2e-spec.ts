/**
 * The shared rate limiter against a REAL Redis: two "servers" share one count,
 * a window resets, blocking holds, parallel hits are all counted, and an
 * unreachable Redis falls back to per-process limits instead of failing.
 * Skipped unless TEST_REDIS_URL is set.
 */
import { RedisThrottlerStorage } from '../src/common/throttler/redis-throttler.storage';

const url = process.env.TEST_REDIS_URL;
const d = url ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('Redis rate limiting', () => {
  const stores: RedisThrottlerStorage[] = [];
  const make = async (u = url!) => {
    const s = new RedisThrottlerStorage(u);
    stores.push(s);
    for (let i = 0; i < 50 && !s.shared && u === url; i++) await sleep(20);
    return s;
  };
  const key = () => `k${Date.now()}${Math.random()}`;
  afterAll(async () => {
    for (const s of stores) await s.onModuleDestroy();
  });

  it('counts hits from two instances against one limit', async () => {
    const [a, b] = [await make(), await make()];
    const k = key();
    const hits: number[] = [];
    for (let i = 0; i < 3; i++) hits.push((await a.increment(k, 60_000, 5, 0, 'default')).totalHits);
    for (let i = 0; i < 3; i++) hits.push((await b.increment(k, 60_000, 5, 0, 'default')).totalHits);
    expect(hits).toEqual([1, 2, 3, 4, 5, 6]); // the 6th, on the other server, is over the limit of 5
  });

  it('keeps separate counts per client and per throttler name', async () => {
    const a = await make();
    const k = key();
    await a.increment(k, 60_000, 5, 0, 'default');
    expect((await a.increment(key(), 60_000, 5, 0, 'default')).totalHits).toBe(1);
    expect((await a.increment(k, 60_000, 5, 0, 'strict')).totalHits).toBe(1);
  });

  it('starts a new window once the old one ends, and reports the time left', async () => {
    const a = await make();
    const k = key();
    const first = await a.increment(k, 1000, 2, 0, 'default');
    expect(first.timeToExpire).toBe(1);
    await a.increment(k, 1000, 2, 0, 'default');
    await sleep(1150);
    expect((await a.increment(k, 1000, 2, 0, 'default')).totalHits).toBe(1);
  });

  it('counts every one of many simultaneous requests', async () => {
    const [a, b] = [await make(), await make()];
    const k = key();
    const all = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).increment(k, 60_000, 100, 0, 'default')));
    expect(Math.max(...all.map((r) => r.totalHits))).toBe(40);
    expect(new Set(all.map((r) => r.totalHits)).size).toBe(40); // no two requests saw the same count
  });

  it('blocks a client that goes over the limit, for the block duration', async () => {
    const a = await make();
    const k = key();
    for (let i = 0; i < 2; i++) expect((await a.increment(k, 60_000, 2, 1000, 'default')).isBlocked).toBe(false);
    const over = await a.increment(k, 60_000, 2, 1000, 'default');
    expect(over).toMatchObject({ isBlocked: true, timeToBlockExpire: 1 });
    expect((await a.increment(k, 60_000, 2, 1000, 'default')).isBlocked).toBe(true);
    await sleep(1150);
    expect((await a.increment(k, 60_000, 2, 1000, 'default')).isBlocked).toBe(false);
  });

  it('falls back to counting in-process when Redis is unreachable', async () => {
    const down = await make('redis://127.0.0.1:1');
    expect(down.shared).toBe(false);
    const k = key();
    const hits: number[] = [];
    for (let i = 0; i < 3; i++) hits.push((await down.increment(k, 60_000, 5, 0, 'default')).totalHits);
    expect(hits).toEqual([1, 2, 3]);
  });
});
