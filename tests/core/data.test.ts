import { describe, expect, it } from 'vitest';
import { COPY_ZH_CN } from '../../src/data/copy-zh-cn';
import { CURRENCIES, RATES_UPDATED } from '../../src/data/currencies';
import { PRICE_PACK_HK, PRICE_PACK_UPDATED } from '../../src/data/price-pack-hk';
import { getRegionPreset, REGION_PRESETS } from '../../src/data/regions';

describe('built-in data', () => {
  it('has 7 currencies with symbol, name, positive USD rate and an update date', () => {
    expect(CURRENCIES.map((c) => c.code)).toEqual(['HKD', 'CNY', 'USD', 'GBP', 'EUR', 'CAD', 'AUD']);
    expect(CURRENCIES.map((c) => c.symbol)).toEqual(['HK$', '¥', 'US$', '£', '€', 'C$', 'A$']);
    for (const c of CURRENCIES) {
      expect(c.rateToUsd).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
    expect(CURRENCIES.find((c) => c.code === 'USD')!.rateToUsd).toBe(1);
    expect(RATES_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICE_PACK_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has at least 15 price items and the copy library has 3 x 4 x >=10 entries', () => {
    expect(PRICE_PACK_HK.length).toBeGreaterThanOrEqual(15);
    let templates = 0;
    for (const intensity of Object.values(COPY_ZH_CN)) for (const list of Object.values(intensity)) templates += list.length;
    expect(Object.keys(COPY_ZH_CN)).toHaveLength(3);
    expect(templates).toBeGreaterThanOrEqual(120);
  });

  it('has the two region presets', () => {
    expect(REGION_PRESETS).toHaveLength(2);
    expect(getRegionPreset('northern')).toMatchObject({ yearStart: '08-01', splitDate: '12-25' });
    expect(getRegionPreset('southern')).toMatchObject({ yearStart: '01-01', splitDate: '07-01' });
    expect(getRegionPreset('nowhere' as 'northern').id).toBe('northern');
  });
});
