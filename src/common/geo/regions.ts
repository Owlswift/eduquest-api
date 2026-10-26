import { Region } from '@prisma/client';
import { canonicalState, NIGERIAN_STATES, NigerianState } from './nigerian-states';

/** The six geopolitical zones. Every state is in exactly one. */
export const REGION_STATES: Record<Region, NigerianState[]> = {
  NORTH_CENTRAL: ['Benue', 'Kogi', 'Kwara', 'Nasarawa', 'Niger', 'Plateau', 'FCT'],
  NORTH_EAST: ['Adamawa', 'Bauchi', 'Borno', 'Gombe', 'Taraba', 'Yobe'],
  NORTH_WEST: ['Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Sokoto', 'Zamfara'],
  SOUTH_EAST: ['Abia', 'Anambra', 'Ebonyi', 'Enugu', 'Imo'],
  SOUTH_SOUTH: ['Akwa Ibom', 'Bayelsa', 'Cross River', 'Delta', 'Edo', 'Rivers'],
  SOUTH_WEST: ['Ekiti', 'Lagos', 'Ogun', 'Ondo', 'Osun', 'Oyo'],
};

export const REGION_LABEL: Record<Region, string> = {
  NORTH_CENTRAL: 'North Central',
  NORTH_EAST: 'North East',
  NORTH_WEST: 'North West',
  SOUTH_EAST: 'South East',
  SOUTH_SOUTH: 'South South',
  SOUTH_WEST: 'South West',
};

const REGION_OF = new Map<string, Region>(
  (Object.entries(REGION_STATES) as [Region, NigerianState[]][]).flatMap(([region, states]) =>
    states.map((s) => [s, region] as const),
  ),
);

/** The zone a state belongs to, or null for an unknown/blank state. */
export function regionOfState(state: string | null | undefined): Region | null {
  const canonical = canonicalState(state);
  return canonical ? (REGION_OF.get(canonical) ?? null) : null;
}

// Fail at start-up, not in front of a student, if the table above ever drifts.
if (REGION_OF.size !== NIGERIAN_STATES.length) {
  throw new Error('REGION_STATES must cover every Nigerian state exactly once');
}
