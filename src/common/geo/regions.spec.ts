import { Region } from '@prisma/client';
import { NIGERIAN_STATES } from './nigerian-states';
import { REGION_STATES, regionOfState } from './regions';

describe('regions', () => {
  it('puts every state in exactly one zone', () => {
    const all = Object.values(REGION_STATES).flat();
    expect(all).toHaveLength(NIGERIAN_STATES.length);
    expect(new Set(all)).toEqual(new Set(NIGERIAN_STATES));
  });

  it.each([
    ['Lagos', Region.SOUTH_WEST],
    ['lagos state', Region.SOUTH_WEST],
    ['Kano', Region.NORTH_WEST],
    ['FCT', Region.NORTH_CENTRAL],
    ['Abuja', Region.NORTH_CENTRAL],
    ['Rivers', Region.SOUTH_SOUTH],
    ['Enugu', Region.SOUTH_EAST],
    ['Borno', Region.NORTH_EAST],
  ])('places %s in %s', (state, region) => expect(regionOfState(state)).toBe(region));

  it('has no zone for an unknown or missing state', () => {
    expect(regionOfState('Accra')).toBeNull();
    expect(regionOfState(null)).toBeNull();
    expect(regionOfState('')).toBeNull();
  });
});
