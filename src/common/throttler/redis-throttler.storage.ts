import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

// One atomic step per request, so servers sharing the counter cannot miscount.
// KEYS[1] hit counter, KEYS[2] block flag. ARGV: window ms, limit, block ms.
// Returns { hits, window ms left, blocked (0/1), block ms left }.
const INCREMENT = `
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  return { tonumber(ARGV[2]) + 1, math.max(redis.call('PTTL', KEYS[1]), 0), 1, blockLeft }
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local left = redis.call('PTTL', KEYS[1])
if left < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); left = tonumber(ARGV[1]) end
local blockMs = tonumber(ARGV[3])
if blockMs > 0 and hits > tonumber(ARGV[2]) then
  -- Start the block, and forget the hits so counting begins afresh once it ends.
  redis.call('SET', KEYS[2], '1', 'PX', blockMs)
  redis.call('DEL', KEYS[1])
  return { hits, left, 1, blockMs }
end
return { hits, left, 0, 0 }
`;

/**
 * Rate-limit counters shared by every API instance through Redis, so a
 * client cannot get N times the limit by hitting N servers. If Redis is
 * unreachable it falls back to counting in this process: limits get looser
 * (per instance) but requests are never refused because of the outage.
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly log = new Logger('Throttler');
  private readonly redis: Redis;
  private readonly local = new ThrottlerStorageService();
  private warned = false;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on('error', (e) => {
      if (!this.warned) this.log.warn(`Redis unavailable, rate limits are per instance until it returns: ${e.message}`);
      this.warned = true;
    });
    this.redis.on('ready', () => {
      if (this.warned) this.log.log('Redis is back, rate limits are shared again.');
      this.warned = false;
    });
    this.redis.connect().catch(() => undefined);
  }

  get shared(): boolean {
    return this.redis.status === 'ready';
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    if (this.redis.status === 'ready') {
      try {
        const base = `throttle:${throttlerName}:${key}`;
        const [hits, left, blocked, blockLeft] = (await this.redis.eval(INCREMENT, 2, base, `${base}:blocked`, ttl, limit, blockDuration)) as number[];
        return { totalHits: hits, timeToExpire: Math.ceil(left / 1000), isBlocked: blocked === 1, timeToBlockExpire: Math.ceil(blockLeft / 1000) };
      } catch {
        // fall through to the local counter
      }
    }
    return this.local.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  async onModuleDestroy() {
    this.local.onApplicationShutdown();
    if (this.redis.status === 'ready') await this.redis.quit().catch(() => undefined);
    else this.redis.disconnect(); // stops reconnect attempts when Redis was down
  }
}
