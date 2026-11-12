// The optional second currency ("≈ ¥2,450" under the big numbers) and the exchange-rate settings.
//
// The conversion itself is core's `convert` (built-in table + the user's overrides in `config.rates`); this file picks
// the currencies from the config, formats the converted amount, and writes the settings. Rates are never fetched.

import { computed, signal } from '@preact/signals';
import { convert, formatMinor, isCurrencyCode, pairRate, parseRateText, withPairRate, type CurrencyCode, type RateTable } from '../core/money';
import { CURRENCIES, RATES_UPDATED } from '../data/currencies';
import { t } from '../i18n';
import { DEFAULT_CURRENCY } from './config';
import { config, setConfig } from './data';
import { currency as primaryCurrency } from './derived';
import { activeConfig } from './source';

/** The date of the built-in rate table. */
export const RATES_DATE = RATES_UPDATED;

/** The user's rate overrides that are valid (positive numbers for known currencies). */
export function cleanRates(raw: unknown): RateTable {
  const out: RateTable = {};
  if (raw && typeof raw === 'object') {
    for (const c of CURRENCIES) {
      const v = (raw as Record<string, unknown>)[c.code];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[c.code] = v;
    }
  }
  return out;
}

export const rateOverrides = computed<RateTable>(() => cleanRates(activeConfig.value.rates));

/** The second currency, or null when it is off or the same as the main currency. */
export const secondaryCurrency = computed<CurrencyCode | null>(() => {
  const raw = activeConfig.value.secondaryCurrency;
  return isCurrencyCode(raw) && raw !== primaryCurrency.value ? raw : null;
});

/** "≈ ¥2,450.20": `minor` (in the main currency) converted with core and formatted in the second currency. */
export function convertedText(minor: number, from: CurrencyCode, to: CurrencyCode, rates?: RateTable): string {
  return t('currency.approx', { amount: formatMinor(Math.round(convert(minor, from, to, rates)), to) });
}

/** The small second-currency text for an amount in the main currency, or null while the second currency is off. */
export function secondaryTextOf(minor: number): string | null {
  const to = secondaryCurrency.value;
  if (!to) return null;
  return convertedText(minor, primaryCurrency.value, to, rateOverrides.value);
}

// ------------------------------------------------------------------ settings

/** What the rate field shows: "1 main currency = X second currency", with up to 6 significant digits. */
export function rateFieldText(from: CurrencyCode, to: CurrencyCode, rates?: RateTable): string {
  const v = pairRate(from, to, rates);
  return String(Number(v.toPrecision(6)));
}

export const savedPrimary = computed<CurrencyCode>(() => (isCurrencyCode(config.value.currency) ? config.value.currency : DEFAULT_CURRENCY));

/** The text the user has typed in the rate field, or null while it shows the saved rate. */
export const rateDraft = signal<string | null>(null);

/** Whether any rate was changed by hand. */
export const hasRateOverrides = computed<boolean>(() => Object.keys(cleanRates(config.value.rates)).length > 0);

export function setSecondaryCurrency(code: CurrencyCode | null): void {
  const next = code !== null && code !== savedPrimary.peek() ? code : null;
  rateDraft.value = null;
  setConfig({ ...config.peek(), secondaryCurrency: next });
}

export type RateEdit = 'ok' | 'invalid' | 'off';

/**
 * The user typed a rate ("1 main = X second"). A number greater than zero is saved at once and every converted text
 * updates; zero, negative or non-numeric text is refused (the saved rate stays, the field shows an error).
 */
export function editRateText(text: string): RateEdit {
  rateDraft.value = text;
  const to = config.peek().secondaryCurrency;
  const from = savedPrimary.peek();
  if (!isCurrencyCode(to) || to === from) return 'off';
  const parsed = parseRateText(text);
  if (parsed === null) return 'invalid';
  const next = withPairRate(from, to, parsed, cleanRates(config.peek().rates));
  if (!next) return 'invalid';
  setConfig({ ...config.peek(), rates: next });
  return 'ok';
}

/** Forget every manual rate: back to the built-in table. */
export function resetRates(): void {
  rateDraft.value = null;
  const { rates: _gone, ...rest } = config.peek();
  void _gone;
  setConfig(rest);
}

/** Whether the typed text in the rate field is not an acceptable rate. */
export const rateDraftInvalid = computed<boolean>(() => {
  const draft = rateDraft.value;
  return draft !== null && parseRateText(draft) === null;
});

export function resetCurrencyState(): void {
  rateDraft.value = null;
}
