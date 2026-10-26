import { readFileSync } from 'fs';
import { join } from 'path';

/** The version of legal/privacy-and-safeguarding.md that is current. A test keeps the two in step. */
export const POLICY_VERSION = '2026-11-draft-1';

/** The age in years from the free-text `age` field ("16", "16 years"), or null if it cannot be read. */
export function parseAge(age: string | null | undefined): number | null {
  const m = /\d{1,3}/.exec(age ?? '');
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 5 && n <= 120 ? n : null;
}

/** Under 18, or an age we cannot read: treated as a child, because a mistake that way protects them. */
export function isMinor(age: string | null | undefined): boolean {
  const n = parseAge(age);
  return n === null || n < 18;
}

/** On unless SAFEGUARDING_ENFORCED=false. */
export function safeguardingEnforced(): boolean {
  return process.env.SAFEGUARDING_ENFORCED !== 'false';
}

/**
 * Whether a parent or guardian's agreement is still missing for something that needs it
 * (entering a competition with prizes, claiming a prize that is delivered).
 */
export function guardianConsentMissing(user: { age?: string | null; guardianConsentAt?: Date | null }): boolean {
  return safeguardingEnforced() && isMinor(user.age) && !user.guardianConsentAt;
}

export const GUARDIAN_CONSENT_REASON = 'A parent or guardian needs to agree before you can enter competitions with prizes. Add their details in your profile';

/** The policy text served to the apps. Read once. */
let cached: { version: string; text: string } | null = null;
export function loadPolicy(): { version: string; text: string } {
  if (!cached) {
    const candidates = [process.env.POLICY_FILE, join(process.cwd(), 'legal', 'privacy-and-safeguarding.md'), join(__dirname, '..', '..', '..', 'legal', 'privacy-and-safeguarding.md')];
    let text = '';
    for (const p of candidates) {
      if (!p) continue;
      try {
        text = readFileSync(p, 'utf8');
        break;
      } catch {
        // try the next location
      }
    }
    const version = /\*\*Version:\*\*\s*(\S+)/.exec(text)?.[1] ?? POLICY_VERSION;
    cached = { version, text };
  }
  return cached;
}
