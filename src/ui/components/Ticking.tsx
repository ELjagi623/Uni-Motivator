// Components whose content changes with the clock. They write straight into the DOM from a signal effect, so the
// component functions run once (on mount) no matter how often the time changes. Nothing here re-renders the page.

import { effect, type ReadonlySignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { formatAmountMinor } from '../../core/money';
import { activeNow } from '../../state/now';

export interface TickingTextProps {
  /** Text to show at the given time (UTC ms). */
  compute: (nowMs: number) => string;
  now?: ReadonlySignal<number>;
  class?: string;
  /** Stable name for tests and cross-checks: rendered as `data-field`. */
  field?: string;
}

/** Runs `apply(nowMs)` right away and whenever `now` changes, always with the latest `apply`. */
export function useTick(apply: (nowMs: number) => void, now: ReadonlySignal<number> = activeNow): void {
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => effect(() => latest.current(now.value)), [now]);
}

/** Shared by TickingNumber and TickingText: returns the ref to attach and the text for the first render. */
function useTickingElement(compute: (nowMs: number) => string, now: ReadonlySignal<number>) {
  const ref = useRef<HTMLSpanElement>(null);
  useTick((nowMs) => {
    const el = ref.current;
    if (!el) return;
    const text = compute(nowMs);
    if (el.textContent !== text) el.textContent = text;
  }, now);
  return { ref, initial: compute(now.peek()) };
}

/** Free text that ticks (durations, percentages, ...). */
export function TickingText({ compute, now = activeNow, class: className, field }: TickingTextProps) {
  const { ref, initial } = useTickingElement(compute, now);
  return (
    <span ref={ref} class={className} data-field={field} aria-hidden="true">
      {initial}
    </span>
  );
}

export interface TickingNumberProps {
  /** Amount in integer minor units (cents) at the given time. */
  compute: (nowMs: number) => number;
  now?: ReadonlySignal<number>;
  class?: string;
  field?: string;
}

/**
 * A money amount with two decimals and thousands separators ("2,687.20"), in tabular figures so that the digits do not
 * jitter. It is hidden from screen readers (they would otherwise announce it many times a second); the dashboard has
 * a separate `aria-live="polite"` summary that changes at most once a minute.
 */
export function TickingNumber({ compute, now = activeNow, class: className, field }: TickingNumberProps) {
  const { ref, initial } = useTickingElement((nowMs) => formatAmountMinor(compute(nowMs)), now);
  return (
    <span ref={ref} class={`num${className ? ` ${className}` : ''}`} data-field={field} aria-hidden="true">
      {initial}
    </span>
  );
}
