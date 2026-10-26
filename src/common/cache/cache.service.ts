import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * A small read-through cache for expensive, slightly-stale-is-fine results such
 * as leaderboards. Uses Redis when REDIS_URL is set, so every API instance
 * shares it; otherwise a per-process map, so development and tests need
 * nothing extra. The cache is never the source of truth and a Redis failure
 * only means the loader runs: it can slow a request, never fail it.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly log = new Logger('Cache');
  private redis: Redis | null = null;
  private readonly local = new Map<string, { value: string; expires: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Entries kept in memory when there is no Redis. */
  static readonly MAX_LOCAL_ENTRIES = 500;

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
      this.redis.on('error', (e) => this.log.warn(`Redis unavailable, serving uncached: ${e.message}`));
      this.redis.connect().catch(() => undefined);
    }
  }

  /** The cached value for `key`, or the loader's result (stored for `ttlSec`).
   *  Concurrent callers for the same key share one load. */
  async remember<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = await this.read<T>(key);
    if (hit !== undefined) return { value: hit, cached: true };

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return { value: await pending, cached: false };

    const load = (async () => {
      const value = await loader();
      await this.write(key, value, ttlSec);
      return value;
    })();
    this.inFlight.set(key, load);
    try {
      return { value: await load, cached: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  async invalidate(prefix: string): Promise<void> {
    for (const k of [...this.local.keys()]) if (k.startsWith(prefix)) this.local.delete(k);
    if (this.redis?.status === 'ready') {
      try {
        const keys = await this.redis.keys(`${prefix}*`);
        if (keys.length > 0) await this.redis.del(...keys);
      } catch {
        // best effort
      }
    }
  }

  private async read<T>(key: string): Promise<T | undefined> {
    if (this.redis?.status === 'ready') {
      try {
        const raw = await this.redis.get(key);
        return raw === null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    }
    const e = this.local.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.local.delete(key);
      return undefined;
    }
    return JSON.parse(e.value) as T;
  }

  private async write(key: string, value: unknown, ttlSec: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.redis?.status === 'ready') {
      try {
        await this.redis.set(key, raw, 'EX', ttlSec);
        return;
      } catch {
        // fall through to memory
      }
    }
    if (this.local.size >= CacheService.MAX_LOCAL_ENTRIES) {
      const oldest = this.local.keys().next().value;
      if (oldest !== undefined) this.local.delete(oldest);
    }
    this.local.set(key, { value: raw, expires: Date.now() + ttlSec * 1000 });
  }

  async onModuleDestroy() {
    if (!this.redis) return;
    // QUIT waits for the server, which never answers when Redis is down:
    // only ask nicely if we are connected, otherwise just drop the socket and
    // stop the reconnect timer so shutdown cannot hang.
    if (this.redis.status === 'ready') await this.redis.quit().catch(() => this.redis?.disconnect());
    else this.redis.disconnect();
  }
}
