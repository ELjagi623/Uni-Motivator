import { describe, expect, it } from 'vitest';
import { convert, isValidRate, pairRate, parseRateText, withPairRate } from '../../src/core/money';

describe('exchange rates: pair rates, overrides and validation', () => {
  it('the pair rate follows the built-in table (1 HKD = 0.128 / 0.139 CNY) and the overrides', () => {
    expect(pairRate('HKD', 'CNY')).toBeCloseTo(0.128 / 0.139, 10);
    expect(pairRate('HKD', 'HKD')).toBe(1);
    expect(pairRate('HKD', 'CNY', { CNY: 0.14 })).toBeCloseTo(0.128 / 0.14, 10);
  });

  it('withPairRate makes "1 from = X to" true for the pair and leaves other currencies alone', () => {
    const rates = withPairRate('HKD', 'CNY', 0.92, { GBP: 1.25 });
    expect(rates).not.toBeNull();
    expect(pairRate('HKD', 'CNY', rates!)).toBeCloseTo(0.92, 10);
    expect(rates!.GBP).toBe(1.25);
    expect(convert(10_000, 'HKD', 'CNY', rates!)).toBeCloseTo(9_200, 6);
  });

  it('zero, negative, NaN, infinite rates and a currency against itself are refused', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(withPairRate('HKD', 'CNY', bad)).toBeNull();
    expect(withPairRate('HKD', 'HKD', 1)).toBeNull();
    expect(isValidRate(0)).toBe(false);
    expect(isValidRate(0.0001)).toBe(true);
    expect(isValidRate('1')).toBe(false);
  });

  it('parses typed rates: plain and with separators, but not zero, negative or text', () => {
    expect(parseRateText('0.92')).toBe(0.92);
    expect(parseRateText(' 1,000.5 ')).toBe(1000.5);
    expect(parseRateText('.5')).toBe(0.5);
    for (const bad of ['0', '0.0', '-1', '', 'abc', '1e3', '1.2.3', '--1']) expect(parseRateText(bad)).toBeNull();
  });
});
