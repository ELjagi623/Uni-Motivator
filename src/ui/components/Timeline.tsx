// Today's timeline: every class of the day on one axis, the current position highlighted and updated in place.

import type { ReadonlySignal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { t } from '../../i18n';
import { cssPercent, liveAt, type DashboardModel } from '../../state/dashboard';
import { useTick } from './Ticking';

export interface TimelineProps {
  model: DashboardModel;
  now?: ReadonlySignal<number>;
}

export function Timeline({ model, now }: TimelineProps) {
  const markerRef = useRef<HTMLElement>(null);
  const elapsedRef = useRef<HTMLElement>(null);
  const currentId = model.active[0]?.id ?? null;

  useTick((nowMs) => {
    const live = liveAt(model, currentId, nowMs);
    const marker = markerRef.current;
    if (marker) {
      marker.style.display = live.markerPct === null ? 'none' : '';
      if (live.markerPct !== null) marker.style.left = cssPercent(live.markerPct);
    }
    const elapsed = elapsedRef.current;
    if (elapsed) {
      elapsed.style.left = cssPercent(live.elapsedLeftPct);
      elapsed.style.width = cssPercent(live.elapsedWidthPct);
    }
  }, now);

  if (model.timeline.length === 0) return null;
  const current = model.timeline.find((item) => item.current);
  return (
    <div class="timeline-block" id="timeline">
      <div class="timeline" aria-hidden="true">
        {model.timeline.map((item) => (
          <b key={item.id} class={item.cancelled ? 'is-cancelled' : undefined} style={{ left: item.left, width: item.width, background: item.color || undefined }} />
        ))}
        {current ? <b ref={elapsedRef} class="timeline__elapsed" style={{ background: current.color || undefined }} /> : null}
        <u ref={markerRef} class="timeline__marker" />
      </div>
      <ol class="timeline__labels" aria-label={t('dashboard.timelineAria')}>
        {model.timeline.map((item) => (
          <li key={item.id}>
            <span class="num small">
              {item.startText}–{item.endText}
            </span>{' '}
            <span>{item.label}</span>
            {item.current ? <span class="tag"> {t('dashboard.tagNow')}</span> : null}
            {item.cancelled ? <span class="tag tag--cancel"> {t('dashboard.tagCancelled')}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
