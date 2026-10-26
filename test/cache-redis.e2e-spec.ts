/**
 * The cache's Redis mode against a REAL Redis: two instances share entries,
 * entries expire, and a Redis outage falls back to loading. Skipped unless
 * TEST_REDIS_URL is set.
 */
import { CacheService } from '../src/common/cache/cache.service';

const url = process.env.TEST_REDIS_URL;
const d = url ? describe : describe.skip;

d('cache (real Redis)', () => {
  const made: CacheService[] = [];
  const open = async () => {
    process.env.REDIS_URL = url;
    const c = new CacheService();
    made.push(c);
    for (let i = 0; i < 50 && (c as any).redis?.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
    return c;
  };
  const key = (s: string) => `test:${Date.now()}:${s}`;

  afterAll(async () => {
    for (const c of made) await c.onModuleDestroy();
    delete process.env.REDIS_URL;
  });

  it('shares a cached value between API instances', async () => {
    const [a, b] = [await open(), await open()];
    const k = key('shared');
    const loadA = jest.fn().mockResolvedValue({ top: [1, 2, 3] });
    const loadB = jest.fn().mockResolvedValue({ top: ['other'] });
    expect(await a.remember(k, 30, loadA)).toEqual({ value: { top: [1, 2, 3] }, cached: false });
    expect(await b.remember(k, 30, loadB)).toEqual({ value: { top: [1, 2, 3] }, cached: true }); // instance B never loads
    expect(loadB).not.toHaveBeenCalled();
  });

  it('expires entries', async () => {
    const c = await open();
    const k = key('ttl');
    await c.remember(k, 1, async () => 'first');
    await new Promise((r) => setTimeout(r, 1300));
    expect(await c.remember(k, 1, async () => 'second')).toEqual({ value: 'second', cached: false });
  });

  it('drops a prefix everywhere', async () => {
    const [a, b] = [await open(), await open()];
    const p = key('inv');
    await a.remember(`${p}:1`, 30, async () => 1);
    await a.invalidate(p);
    expect((await b.remember(`${p}:1`, 30, async () => 2)).cached).toBe(false);
  });

  it('still answers (uncached) when Redis is unreachable', async () => {
    process.env.REDIS_URL = 'redis://localhost:6390'; // nothing listens here
    const c = new CacheService();
    made.push(c);
    const loader = jest.fn().mockResolvedValue('from the database');
    await expect(c.remember(key('down'), 30, loader)).resolves.toEqual({ value: 'from the database', cached: false });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
