import { CacheService } from './cache.service';

describe('CacheService (in-memory)', () => {
  let cache: CacheService;
  beforeEach(() => {
    delete process.env.REDIS_URL;
    cache = new CacheService();
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T10:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('loads once, then serves the stored value until it expires', async () => {
    const loader = jest.fn().mockResolvedValue({ n: 1 });
    expect(await cache.remember('k', 60, loader)).toEqual({ value: { n: 1 }, cached: false });
    expect(await cache.remember('k', 60, loader)).toEqual({ value: { n: 1 }, cached: true });
    expect(loader).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-06-15T10:01:01Z')); // past the 60s ttl
    loader.mockResolvedValue({ n: 2 });
    expect(await cache.remember('k', 60, loader)).toEqual({ value: { n: 2 }, cached: false });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('shares one load between simultaneous callers', async () => {
    let release!: (v: string) => void;
    const loader = jest.fn(() => new Promise<string>((r) => (release = r)));
    const calls = [cache.remember('slow', 60, loader), cache.remember('slow', 60, loader), cache.remember('slow', 60, loader)];
    await Promise.resolve();
    release('done');
    const out = await Promise.all(calls);
    expect(out.map((o) => o.value)).toEqual(['done', 'done', 'done']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load, and lets the next caller retry', async () => {
    const loader = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue('ok');
    await expect(cache.remember('flaky', 60, loader)).rejects.toThrow('db down');
    expect((await cache.remember('flaky', 60, loader)).value).toBe('ok');
  });

  it('keeps keys apart and can drop a prefix', async () => {
    await cache.remember('lb:a', 60, async () => 1);
    await cache.remember('lb:b', 60, async () => 2);
    await cache.remember('other', 60, async () => 3);
    await cache.invalidate('lb:');
    expect((await cache.remember('lb:a', 60, async () => 10)).cached).toBe(false);
    expect((await cache.remember('other', 60, async () => 30)).cached).toBe(true);
  });

  it('stays within its size cap by dropping the oldest', async () => {
    for (let i = 0; i < CacheService.MAX_LOCAL_ENTRIES + 20; i++) await cache.remember(`k${i}`, 60, async () => i);
    expect((await cache.remember('k0', 60, async () => 'reloaded')).cached).toBe(false);
    expect((await cache.remember(`k${CacheService.MAX_LOCAL_ENTRIES + 19}`, 60, async () => 'x')).cached).toBe(true);
  });
});
