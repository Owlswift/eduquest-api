import { readFileSync } from 'fs';
import { join } from 'path';
import { guardianConsentMissing, isMinor, loadPolicy, parseAge, POLICY_VERSION } from './safeguarding';

describe('age and minors', () => {
  it('reads an age out of free text', () => {
    expect([parseAge('16'), parseAge(' 17 years'), parseAge('age: 15'), parseAge('18')]).toEqual([16, 17, 15, 18]);
    expect([parseAge(null), parseAge(''), parseAge('sixteen'), parseAge('2'), parseAge('999')]).toEqual([null, null, null, null, null]);
  });
  it('treats under 18, and an age it cannot read, as a child', () => {
    expect([isMinor('17'), isMinor('18'), isMinor('25'), isMinor(null), isMinor('n/a')]).toEqual([true, false, false, true, true]);
  });
});

describe('guardianConsentMissing', () => {
  afterEach(() => delete process.env.SAFEGUARDING_ENFORCED);
  it('is missing for a child with no agreement, and satisfied once there is one', () => {
    expect(guardianConsentMissing({ age: '16' })).toBe(true);
    expect(guardianConsentMissing({ age: null })).toBe(true);
    expect(guardianConsentMissing({ age: '16', guardianConsentAt: new Date() })).toBe(false);
  });
  it('never asks an adult', () => {
    expect(guardianConsentMissing({ age: '19' })).toBe(false);
  });
  it('can be switched off', () => {
    process.env.SAFEGUARDING_ENFORCED = 'false';
    expect(guardianConsentMissing({ age: '12' })).toBe(false);
  });
});

describe('the policy document', () => {
  it('has the version the code says is current, and is served as written', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'legal', 'privacy-and-safeguarding.md'), 'utf8');
    expect(/\*\*Version:\*\*\s*(\S+)/.exec(text)?.[1]).toBe(POLICY_VERSION);
    expect(loadPolicy()).toEqual({ version: POLICY_VERSION, text });
  });
  it('still says it is a draft until someone removes the placeholders', () => {
    const { text } = loadPolicy();
    // Not a rule about wording: a reminder that publishing with open placeholders is a mistake.
    const open = (text.match(/\[PLACEHOLDER/g) ?? []).length;
    expect(open === 0 || /DRAFT/.test(text)).toBe(true);
  });
});
