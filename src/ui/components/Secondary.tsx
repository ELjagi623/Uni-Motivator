// The small second-currency line under a big number ("≈ ¥2,450.20"). Nothing is shown while the second currency is off.
// The conversion is core's `convert` (src/state/currency.ts); this component only places the text.

import { secondaryCurrency, secondaryTextOf } from '../../state/currency';
import { TickingText } from './Ticking';

export interface SecondaryAmountProps {
  /** A fixed amount in the main currency (minor units). */
  minor?: number;
  /** Or an amount that moves with time: given `now`, the amount in the main currency (minor units). */
  compute?: (nowMs: number) => number;
  field?: string;
}

export function SecondaryAmount({ minor, compute, field }: SecondaryAmountProps) {
  if (!secondaryCurrency.value) return null;
  if (compute) {
    return <TickingText class="muted small money secondary-amount" field={field} compute={(nowMs) => secondaryTextOf(compute(nowMs)) ?? ''} />;
  }
  return (
    <span class="muted small money secondary-amount" data-field={field}>
      {secondaryTextOf(minor ?? 0)}
    </span>
  );
}
