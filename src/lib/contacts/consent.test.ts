import { describe, expect, it } from 'vitest';

import { broadcastEligibility, classifyOptKeyword, parseConsentCell } from './consent';

describe('parseConsentCell', () => {
  it.each([
    ['yes', true], ['Y', true], ['TRUE', true], ['1', true], [true, true], [1, true],
    ['no', false], ['N', false], ['false', false], ['0', false], [false, false], [0, false],
    ['', undefined], ['maybe', undefined], [null, undefined], [undefined, undefined],
  ])('%j → %j', (input, expected) => {
    expect(parseConsentCell(input)).toBe(expected);
  });
});

describe('broadcastEligibility', () => {
  const none = new Set<string>();
  it('allows a consented contact that is not excluded', () => {
    expect(broadcastEligibility({ phone: '+923105478805', consent_status: 'granted' }, none)).toEqual({ eligible: true });
  });
  it('blocks a contact without recorded consent', () => {
    expect(broadcastEligibility({ phone: '+923105478805', consent_status: 'unknown' }, none)).toEqual({ eligible: false, reason: 'no_consent' });
    expect(broadcastEligibility({ phone: '+923105478805' }, none)).toEqual({ eligible: false, reason: 'no_consent' });
  });
  it('blocks an excluded number even with consent, whatever its formatting', () => {
    const excluded = new Set(['923105478805']);
    expect(broadcastEligibility({ phone: '+92 310 5478805', consent_status: 'granted' }, excluded)).toEqual({ eligible: false, reason: 'excluded' });
  });
});

describe('classifyOptKeyword', () => {
  it.each([
    ['STOP', 'stop'], [' stop. ', 'stop'], ['Unsubscribe', 'stop'], ['band karo', 'stop'], ['بند کرو', 'stop'],
    ['START', 'start'], ['subscribe', 'start'],
    ["please don't stop", null], ['stopping by later', null], ['', null], [null, null],
  ])('%j → %j', (input, expected) => {
    expect(classifyOptKeyword(input as string | null)).toBe(expected);
  });
});
