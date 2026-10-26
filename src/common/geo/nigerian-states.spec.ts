import { canonicalState, NIGERIAN_STATES } from './nigerian-states';

describe('canonicalState', () => {
  it('has 36 states plus the FCT, all distinct', () => {
    expect(NIGERIAN_STATES).toHaveLength(37);
    expect(new Set(NIGERIAN_STATES).size).toBe(37);
  });

  it.each([
    ['lagos', 'Lagos'],
    ['  LAGOS ', 'Lagos'],
    ['Lagos State', 'Lagos'],
    ['cross-river', 'Cross River'],
    ['CROSS RIVER state', 'Cross River'],
    ['akwa ibom', 'Akwa Ibom'],
    ['Abuja', 'FCT'],
    ['Federal Capital Territory', 'FCT'],
    ['fct', 'FCT'],
    ['Nasarawa', 'Nasarawa'],
  ])('maps %s to %s', (input, expected) => expect(canonicalState(input)).toBe(expected));

  it('is idempotent for every canonical state', () => {
    for (const s of NIGERIAN_STATES) expect(canonicalState(s)).toBe(s);
  });

  it.each([['Accra'], [''], ['   '], [null], [undefined], [42]])('rejects %p', (v) => expect(canonicalState(v)).toBeNull());
});
