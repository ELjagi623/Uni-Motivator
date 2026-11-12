import { describe, expect, it } from 'vitest';
import {
  convert,
  formatAmountMinor,
  formatMajor,
  formatMinor,
  formatMinorWhole,
  getCurrency,
  isCurrencyCode,
  majorToMinor,
  minorToMajor,
  type CurrencyCode,
} from '../../src/core/money';
import { CURRENCIES } from '../../src/data/currencies';

const CODES = CURRENCIES.map((c) => c.code);

describe('formatting', () => {
  it('formats all 7 currencies with symbol, two decimals and thousands separators', () => {
    const expected: Record<CurrencyCode, string> = {
      HKD: 'HK$398,000.00',
      CNY: '¥398,000.00',
      USD: 'US$398,000.00',
      GBP: '£398,000.00',
      EUR: '€398,000.00',
      CAD: 'C$398,000.00',
      AUD: 'A$398,000.00',
    };
    expect(CODES.sort()).toEqual(Object.keys(expected).sort());
    for (const code of CODES) expect(formatMinor(39_800_000, code), code).toBe(expected[code]);
  });

  it('handles small, zero, rounding and negative amounts', () => {
    expect(formatMinor(0, 'HKD')).toBe('HK$0.00');
    expect(formatMinor(5, 'HKD')).toBe('HK$0.05');
    expect(formatMinor(99, 'USD')).toBe('US$0.99');
    expect(formatMinor(100, 'USD')).toBe('US$1.00');
    expect(formatMinor(123_456_789, 'GBP')).toBe('£1,234,567.89');
    expect(formatMinor(350.6, 'HKD')).toBe('HK$3.51'); // minor amounts are rounded to whole cents
    expect(formatMinor(-1250, 'EUR')).toBe('-€12.50');
    expect(formatAmountMinor(398_000)).toBe('3,980.00');
    expect(formatMajor(3980, 'HKD')).toBe('HK$3,980.00');
    expect(formatMajor(0.1 + 0.2, 'HKD')).toBe('HK$0.30');
  });

  it('formats whole units for tab titles by dropping (not rounding) the fraction', () => {
    expect(formatMinorWhole(268_799, 'HKD')).toBe('HK$2,687');
    expect(formatMinorWhole(99, 'HKD')).toBe('HK$0');
    expect(formatMinorWhole(123_456_700, 'USD')).toBe('US$1,234,567');
  });

  it('knows its currencies', () => {
    expect(getCurrency('HKD').symbol).toBe('HK$');
    expect(() => getCurrency('XXX' as CurrencyCode)).toThrow();
    expect(isCurrencyCode('CAD')).toBe(true);
    expect(isCurrencyCode('cad')).toBe(false);
    expect(isCurrencyCode(5)).toBe(false);
  });
});

describe('majorToMinor', () => {
  it('converts typed amounts without floating-point error', () => {
    expect(majorToMinor('398000.5')).toBe(39_800_050);
    expect(majorToMinor('398,000')).toBe(39_800_000);
    expect(majorToMinor(' 1 234.56 ')).toBe(123_456);
    expect(majorToMinor('0.1')).toBe(10);
    expect(majorToMinor('0.29')).toBe(29); // 0.29 * 100 = 28.999999999999996 in floating point
    expect(majorToMinor('1.005')).toBe(101); // third digit rounds half up
    expect(majorToMinor('1.004')).toBe(100);
    expect(majorToMinor('.5')).toBe(50);
    expect(majorToMinor('5.')).toBe(500);
    expect(majorToMinor('0')).toBe(0);
    expect(majorToMinor('000398000.50')).toBe(39_800_050);
  });

  it('accepts numbers too', () => {
    expect(majorToMinor(398000.5)).toBe(39_800_050);
    expect(majorToMinor(0.1 + 0.2)).toBe(30);
    expect(majorToMinor(1.005)).toBe(101);
    expect(majorToMinor(19.99)).toBe(1999);
  });

  it('rejects anything that is not a non-negative amount', () => {
    for (const bad of ['', ' ', 'abc', '-5', '1.2.3', '1e3', '$5', '.']) expect(majorToMinor(bad), bad).toBeNull();
    expect(majorToMinor(NaN)).toBeNull();
    expect(majorToMinor(Infinity)).toBeNull();
    expect(majorToMinor('9'.repeat(30))).toBeNull();
  });

  it('round-trips with minorToMajor', () => {
    expect(minorToMajor(39_800_050)).toBe(398_000.5);
    for (const minor of [0, 1, 99, 100, 12_345, 39_800_000]) expect(majorToMinor(minorToMajor(minor))).toBe(minor);
  });
});

describe('convert', () => {
  it('is the identity for the same currency', () => {
    expect(convert(1234.5, 'HKD', 'HKD')).toBe(1234.5);
  });

  it('round trips with an error far below one cent for every pair of currencies', () => {
    const amounts = [1, 99, 4500, 398_000, 39_800_000, 123_456_789];
    for (const from of CODES) {
      for (const to of CODES) {
        for (const a of amounts) {
          const back = convert(convert(a, from, to), to, from);
          expect(Math.abs(back - a), `${from}->${to} ${a}`).toBeLessThan(0.01);
        }
      }
    }
  });

  it('uses the USD rates: 1 USD = 1/0.128 HKD', () => {
    expect(convert(100, 'USD', 'HKD')).toBeCloseTo(100 / 0.128, 9);
    expect(convert(100, 'HKD', 'USD')).toBeCloseTo(12.8, 9);
  });

  it('lets the caller override rates', () => {
    expect(convert(100, 'USD', 'HKD', { HKD: 0.125 })).toBeCloseTo(800, 9);
    expect(convert(100, 'USD', 'HKD', { HKD: 0 })).toBeCloseTo(100 / 0.128, 9); // invalid override ignored
  });
});
