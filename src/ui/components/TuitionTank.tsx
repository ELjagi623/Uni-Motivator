// The tuition "tank": how much of this semester's (or year's) tuition has burned, how much is left, and the percentage.

import type { ReadonlySignal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { getCurrency, type CurrencyCode } from '../../core/money';
import { t } from '../../i18n';
import { liveAt, percentText, poolFillWidth, type DashboardModel } from '../../state/dashboard';
import { TickingNumber, TickingText, useTick } from './Ticking';

export interface TuitionTankProps {
  model: DashboardModel;
  currency: CurrencyCode;
  /** The session on display (its pool is the tank's pool), or null for the model's default pool. */
  sessionId: string | null;
  now?: ReadonlySignal<number>;
}

export function TuitionTank({ model, currency, sessionId, now }: TuitionTankProps) {
  const fillRef = useRef<HTMLElement>(null);
  const symbol = getCurrency(currency).symbol;

  useTick((nowMs) => {
    const fill = fillRef.current;
    if (fill) fill.style.width = poolFillWidth(model, sessionId, nowMs);
  }, now);

  if (!model.pool) return null;
  const label = model.pool.semester === null ? t('dashboard.tankYear') : t('dashboard.tankSemester');
  return (
    <div class="card tank-card" id="tank">
      <span class="label">{label}</span>
      <div class="tank" role="presentation">
        <i ref={fillRef} />
      </div>
      <div class="tank__numbers">
        <span class="muted">
          {t('dashboard.burned')}{' '}
          <span class="money">
            {symbol}
            <TickingNumber class="tank__figure" field="pool-consumed" now={now} compute={(nowMs) => liveAt(model, sessionId, nowMs).poolConsumedMinor} />
          </span>
        </span>
        <span class="muted">
          {t('dashboard.left')}{' '}
          <span class="money">
            {symbol}
            <TickingNumber class="tank__figure" field="pool-remaining" now={now} compute={(nowMs) => liveAt(model, sessionId, nowMs).poolRemainingMinor} />
          </span>
        </span>
      </div>
      <span class="num accent tank__percent">
        <TickingText field="pool-percent" now={now} compute={(nowMs) => percentText(liveAt(model, sessionId, nowMs).poolProgress)} />%
      </span>
    </div>
  );
}
