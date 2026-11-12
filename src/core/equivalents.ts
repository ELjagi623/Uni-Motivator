// "What could this money have bought?" Pick everyday items from a price pack.

import { PRICE_PACK_HK, type PriceItem } from '../data/price-pack-hk';
import { convert, MINOR_PER_MAJOR, type CurrencyCode, type RateTable } from './money';

export interface Equivalent {
  item: PriceItem;
  /** Whole items the amount can buy (floor). 0 when the amount is below the cheapest item. */
  count: number;
  /** amount / price, e.g. 0.4 = "0.4 of a cup". Equals `count` + remainder. */
  fraction: number;
  /** True when the amount is below the cheapest item (the cheapest item is returned as a fallback). */
  belowCheapest: boolean;
}

/** Price of an item in minor units of `currency` (a float, so that tiny conversion differences do not shift counts). */
export function itemPriceMinor(item: PriceItem, currency: CurrencyCode, rates?: RateTable): number {
  return convert(item.price * MINOR_PER_MAJOR, item.currency, currency, rates);
}

/** How many of `item` does `amountMinor` (in `currency`) buy? */
export function countOf(amountMinor: number, currency: CurrencyCode, item: PriceItem, rates?: RateTable): { count: number; fraction: number } {
  const price = itemPriceMinor(item, currency, rates);
  const fraction = price > 0 ? Math.max(amountMinor, 0) / price : 0;
  // Compare in rounded minor units so that e.g. 3,980 / 45 is exactly 88 full items, not subject to float noise.
  const count = Math.floor(Math.max(amountMinor, 0) / Math.round(price));
  return { count, fraction };
}

/**
 * The most expensive item that does not exceed `amountMinor`, with how many of it the amount buys.
 * Below the cheapest item the cheapest one is returned with count 0 and `belowCheapest: true`.
 * Returns null only for an empty pack.
 */
export function pickEquivalent(
  amountMinor: number,
  currency: CurrencyCode,
  pack: readonly PriceItem[] = PRICE_PACK_HK,
  rates?: RateTable,
): Equivalent | null {
  if (pack.length === 0) return null;
  const priced = pack
    .map((item) => ({ item, price: Math.round(itemPriceMinor(item, currency, rates)) }))
    .sort((a, b) => a.price - b.price || (a.item.id < b.item.id ? -1 : 1));
  const amount = Math.max(amountMinor, 0);
  let chosen: (typeof priced)[number] | null = null;
  for (const p of priced) if (p.price <= amount && p.price > 0) chosen = p;
  if (!chosen) {
    const cheapest = priced[0];
    return { item: cheapest.item, count: 0, fraction: cheapest.price > 0 ? amount / cheapest.price : 0, belowCheapest: true };
  }
  const { count, fraction } = countOf(amount, currency, chosen.item, rates);
  return { item: chosen.item, count, fraction, belowCheapest: false };
}
