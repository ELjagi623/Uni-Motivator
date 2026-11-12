// Currencies, exchange and formatting. Money inside the app is an integer number of minor units (cents).
// Every built-in currency has 2 decimals, so "minor" is always 1/100 of the major unit.

import { CURRENCIES, type Currency, type CurrencyCode } from '../data/currencies';

export type { CurrencyCode } from '../data/currencies';

/** Optional override of the built-in USD rates: USD value of one major unit. */
export type RateTable = Partial<Record<CurrencyCode, number>>;

export const MINOR_PER_MAJOR = 100;

export function getCurrency(code: CurrencyCode): Currency {
  const c = CURRENCIES.find((x) => x.code === code);
  if (!c) throw new Error(`Unknown currency: ${String(code)}`);
  return c;
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && CURRENCIES.some((c) => c.code === value);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "3,980.00" - always two decimals, thousands separators, no symbol. */
export function formatAmountMinor(minor: number): string {
  const rounded = Math.round(minor);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / MINOR_PER_MAJOR);
  const frac = abs % MINOR_PER_MAJOR;
  return `${negative ? '-' : ''}${groupThousands(String(whole))}.${String(frac).padStart(2, '0')}`;
}

/** "HK$3,980.00" */
export function formatMinor(minor: number, code: CurrencyCode): string {
  const text = formatAmountMinor(minor);
  const symbol = getCurrency(code).symbol;
  return text.startsWith('-') ? `-${symbol}${text.slice(1)}` : `${symbol}${text}`;
}

/** "HK$3,980.00" from an amount in major units (e.g. 3980 or 3980.5). */
export function formatMajor(major: number, code: CurrencyCode): string {
  return formatMinor(majorToMinor(major) ?? Math.round(major * MINOR_PER_MAJOR), code);
}

/** "HK$3,980": whole units only (fraction dropped, not rounded) - for tab titles. */
export function formatMinorWhole(minor: number, code: CurrencyCode): string {
  const rounded = Math.round(minor);
  const negative = rounded < 0;
  const whole = Math.floor(Math.abs(rounded) / MINOR_PER_MAJOR);
  return `${negative ? '-' : ''}${getCurrency(code).symbol}${groupThousands(String(whole))}`;
}

/**
 * Parse an amount typed in major units into integer minor units without floating-point error
 * ("398000.5" -> 39800050). Commas and spaces are ignored; a third decimal digit rounds half up.
 * Returns null for anything that is not a non-negative number.
 */
export function majorToMinor(input: string | number): number | null {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    text = input.toFixed(6);
  } else {
    text = input.replace(/[,\s]/g, '');
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) return null;
  const whole = m[1] === '' ? 0 : Number(m[1]);
  const fracDigits = (m[2] ?? '').padEnd(3, '0');
  let minor = whole * MINOR_PER_MAJOR + Number(fracDigits.slice(0, 2));
  if (Number(fracDigits[2]) >= 5) minor += 1;
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToMajor(minor: number): number {
  return minor / MINOR_PER_MAJOR;
}

function usdRate(code: CurrencyCode, rates?: RateTable): number {
  const override = rates?.[code];
  return typeof override === 'number' && override > 0 ? override : getCurrency(code).rateToUsd;
}

/** Convert an amount between currencies (the unit - minor or major - is preserved). Returns a float. */
export function convert(amount: number, from: CurrencyCode, to: CurrencyCode, rates?: RateTable): number {
  if (from === to) return amount;
  return (amount * usdRate(from, rates)) / usdRate(to, rates);
}

/** A usable exchange rate: a finite number greater than zero. */
export function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** How many `to` units one `from` unit buys (e.g. 1 HKD = 0.9209 CNY), with the built-in table and the overrides. */
export function pairRate(from: CurrencyCode, to: CurrencyCode, rates?: RateTable): number {
  return convert(1, from, to, rates);
}

/**
 * The rate table that makes `1 from = perUnit to`: the override of `to` is set so that, with `from`'s current rate,
 * the pair comes out exactly as asked (the override of `from` is left alone). Returns null when `perUnit` is not a
 * number greater than zero, or when `from` and `to` are the same currency (that pair is always 1).
 */
export function withPairRate(from: CurrencyCode, to: CurrencyCode, perUnit: number, rates?: RateTable): RateTable | null {
  if (!isValidRate(perUnit) || from === to) return null;
  const fromUsd = convert(1, from, 'USD', rates);
  return { ...(rates ?? {}), [to]: fromUsd / perUnit };
}

/** Parse a rate typed by the user ("0.92", "1,000.5"); null when it is not a number greater than zero. */
export function parseRateText(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return isValidRate(n) ? n : null;
}
