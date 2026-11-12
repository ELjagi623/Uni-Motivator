import { describe, expect, it } from 'vitest';
import { countOf, itemPriceMinor, pickEquivalent } from '../../src/core/equivalents';
import { formatMinor } from '../../src/core/money';
import { PRICE_PACK_HK, type PriceItem } from '../../src/data/price-pack-hk';

const sanfan = PRICE_PACK_HK.find((i) => i.id === 'sanfan')!;
const mini: PriceItem[] = [
  { id: 'a', name: 'A', emoji: '', unit: '个', price: 10, currency: 'HKD' },
  { id: 'b', name: 'B', emoji: '', unit: '个', price: 45, currency: 'HKD' },
  { id: 'c', name: 'C', emoji: '', unit: '个', price: 200, currency: 'HKD' },
];

describe('countOf', () => {
  it('HK$3,980 buys 88 boxes of the HK$45 three-dish rice', () => {
    expect(sanfan.price).toBe(45);
    const r = countOf(398_000, 'HKD', sanfan);
    expect(r.count).toBe(88);
    expect(r.fraction).toBeCloseTo(88.444, 3);
    expect(formatMinor(398_000, 'HKD')).toBe('HK$3,980.00');
  });

  it('converts item prices into the display currency', () => {
    expect(itemPriceMinor(sanfan, 'USD')).toBeCloseTo(45 * 0.128 * 100, 9);
    expect(countOf(10_000, 'USD', sanfan).count).toBe(17); // US$100 / US$5.76
  });

  it('is 0 for a non-positive amount', () => {
    expect(countOf(0, 'HKD', sanfan)).toEqual({ count: 0, fraction: 0 });
    expect(countOf(-5, 'HKD', sanfan).count).toBe(0);
  });
});

describe('pickEquivalent', () => {
  it('returns the most expensive item not exceeding the amount, with the count', () => {
    expect(pickEquivalent(398_000, 'HKD', mini)).toMatchObject({ item: { id: 'c' }, count: 19, belowCheapest: false });
    expect(pickEquivalent(20_000, 'HKD', mini)).toMatchObject({ item: { id: 'c' }, count: 1 }); // exactly HK$200
    expect(pickEquivalent(19_999, 'HKD', mini)).toMatchObject({ item: { id: 'b' }, count: 4 });
    expect(pickEquivalent(4500, 'HKD', mini)).toMatchObject({ item: { id: 'b' }, count: 1 });
    expect(pickEquivalent(1000, 'HKD', mini)).toMatchObject({ item: { id: 'a' }, count: 1 });
  });

  it('with the built-in pack picks the priciest affordable item, and 88 sanfan for a pack where that is the dearest', () => {
    const r = pickEquivalent(398_000, 'HKD')!;
    expect(r.item.id).toBe('flight-tokyo');
    expect(r.count).toBe(1);
    const only = pickEquivalent(398_000, 'HKD', [sanfan])!;
    expect(only).toMatchObject({ item: { id: 'sanfan' }, count: 88 });
  });

  it('falls back to the cheapest item with a fraction when the amount is below it', () => {
    const r = pickEquivalent(500, 'HKD')!; // HK$5
    expect(r.belowCheapest).toBe(true);
    expect(r.count).toBe(0);
    expect(r.item.price).toBe(9); // egg tart / bus ride tie at HK$9
    expect(r.fraction).toBeCloseTo(500 / 900, 9);
    expect(pickEquivalent(0, 'HKD')).toMatchObject({ count: 0, fraction: 0, belowCheapest: true });
    expect(pickEquivalent(-100, 'HKD')).toMatchObject({ count: 0, belowCheapest: true });
  });

  it('works in other currencies by converting the prices', () => {
    const r = pickEquivalent(10_000, 'USD')!; // US$100 = about HK$781
    expect(r.item.id).toBe('sneakers'); // HK$699 = US$89.47
    expect(r.count).toBe(1);
  });

  it('returns null for an empty pack and breaks price ties deterministically', () => {
    expect(pickEquivalent(1000, 'HKD', [])).toBeNull();
    const tie: PriceItem[] = [
      { ...mini[0], id: 'z', price: 10 },
      { ...mini[0], id: 'y', price: 10 },
    ];
    expect(pickEquivalent(1000, 'HKD', tie)!.item.id).toBe('z'); // sorted by id ascending, the last one wins among equals
  });
});

describe('the built-in price pack', () => {
  it('has at least 15 well-formed items with unique ids', () => {
    expect(PRICE_PACK_HK.length).toBeGreaterThanOrEqual(15);
    const ids = new Set(PRICE_PACK_HK.map((i) => i.id));
    expect(ids.size).toBe(PRICE_PACK_HK.length);
    for (const item of PRICE_PACK_HK) {
      expect(item.price).toBeGreaterThan(0);
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.unit.length).toBeGreaterThan(0);
      expect(item.emoji.length).toBeGreaterThan(0);
      expect(item.currency).toBe('HKD');
    }
  });
});
