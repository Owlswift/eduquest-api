import type { TaskDefinition } from './jobs.service';

const HOUR = 3_600_000;
// Africa/Lagos is UTC+1 all year (Nigeria has no daylight saving).
const LAGOS_OFFSET_MS = HOUR;
/** A daily task that missed its time by more than this is skipped, not run late. */
export const DAILY_LATENESS_MS = 3 * HOUR;

export interface Slot {
  /** Stable name of this occurrence; with the task name it identifies one run. */
  key: string;
  at: Date;
}

/**
 * The most recent occurrence of a task at or before `now`, or null when it is
 * too late to run it (daily tasks only). Pure, so every instance agrees on the
 * slot and the database decides which one runs it.
 */
export function latestSlot(schedule: TaskDefinition['schedule'], now: Date): Slot | null {
  if ('everyMs' in schedule) {
    const at = new Date(Math.floor(now.getTime() / schedule.everyMs) * schedule.everyMs);
    return { key: at.toISOString(), at };
  }
  const m = /^0 (\d{1,2}) \* \* \*$/.exec(schedule.pattern);
  if (!m || Number(m[1]) > 23) throw new Error(`Unsupported schedule pattern: ${schedule.pattern}`);
  const hour = Number(m[1]);
  // Shift into Lagos wall-clock time, find today's slot there, shift back.
  const lagosDayStart = Math.floor((now.getTime() + LAGOS_OFFSET_MS) / (24 * HOUR)) * 24 * HOUR;
  let atMs = lagosDayStart + hour * HOUR - LAGOS_OFFSET_MS;
  if (atMs > now.getTime()) atMs -= 24 * HOUR;
  if (now.getTime() - atMs > DAILY_LATENESS_MS) return null;
  const at = new Date(atMs);
  const day = new Date(atMs + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
  return { key: `${day}T${String(hour).padStart(2, '0')}:00+01:00`, at };
}
