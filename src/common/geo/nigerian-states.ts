/**
 * The states a student can represent. Spelling matches the mobile app's
 * pickers, with the Federal Capital Territory as `FCT`. State rankings group
 * by exact text, so every write goes through [canonicalState].
 */
export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo',
  'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa',
  'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba',
  'Yobe', 'Zamfara',
] as const;

export type NigerianState = (typeof NIGERIAN_STATES)[number];

const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const BY_KEY = new Map<string, NigerianState>(NIGERIAN_STATES.map((s) => [key(s), s]));
// Common alternative spellings.
BY_KEY.set('abuja', 'FCT');
BY_KEY.set('federalcapitalterritory', 'FCT');
BY_KEY.set('fctabuja', 'FCT');

/** The canonical spelling of a state however it was typed ("lagos", "Lagos State",
 *  "CROSS-RIVER", "Abuja"), or null when it is not a Nigerian state. */
export function canonicalState(input: unknown): NigerianState | null {
  if (typeof input !== 'string') return null;
  const k = key(input);
  return BY_KEY.get(k) ?? BY_KEY.get(k.replace(/state$/, '')) ?? null;
}
