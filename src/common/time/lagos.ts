/** Africa/Lagos is UTC+1 all year (no daylight saving). */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** UTC-midnight Date for the Lagos calendar day containing `now`. Stored as-is
 *  in a Prisma `@db.Date` column. */
export function lagosDate(now: Date = new Date()): Date {
  const l = new Date(now.getTime() + LAGOS_OFFSET_MS);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
}

/** The instant the current Lagos day began. */
export function lagosDayStart(now: Date = new Date()): Date {
  return new Date(lagosDate(now).getTime() - LAGOS_OFFSET_MS);
}

/** The instant the next Lagos day begins (when a daily challenge resets). */
export function lagosNextDayStart(now: Date = new Date()): Date {
  return new Date(lagosDayStart(now).getTime() + 24 * 60 * 60 * 1000);
}
