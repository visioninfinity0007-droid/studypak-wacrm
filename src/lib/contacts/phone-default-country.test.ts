import { describe, expect, it } from 'vitest';

import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { applyDefaultCountry, DEFAULT_COUNTRIES } from './phone-default-country';

const PK = DEFAULT_COUNTRIES.PK;

describe('applyDefaultCountry (Pakistan)', () => {
  it.each([
    ['03105478805', '+923105478805'],
    ['0310 5478805', '+923105478805'],
    ['0310-547-8805', '+923105478805'],
    ['3105478805', '+923105478805'],
    ['923105478805', '+923105478805'],
    ['00923105478805', '+923105478805'],
    ['+923105478805', '+923105478805'],
    ['+44 20 7946 0958', '+44 20 7946 0958'],
  ])('%s → %s', (input, expected) => {
    expect(applyDefaultCountry(input, PK)).toBe(expected);
  });

  it('produces numbers the strict international parser accepts', () => {
    expect(parseInternationalPhone(applyDefaultCountry('0310 5478805', PK))).toBe('923105478805');
  });

  it('leaves numbers it cannot place unchanged (reported invalid later)', () => {
    expect(applyDefaultCountry('12345', PK)).toBe('12345');
    expect(applyDefaultCountry('not a phone', PK)).toBe('not a phone');
    expect(parseInternationalPhone(applyDefaultCountry('12345', PK))).toBeNull();
  });

  it('does nothing without an explicitly chosen country', () => {
    expect(applyDefaultCountry('03105478805', null)).toBe('03105478805');
  });
});
