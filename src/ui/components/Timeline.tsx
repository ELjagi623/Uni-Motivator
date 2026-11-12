// Today's timeline: every class of the day on one axis, the current position highlighted and updated in place.

import type { ReadonlySignal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../../i18n';
import { cssPercent, liveAt, type DashboardModel } from '../../state/dashboard';
import { layoutLabels } from '../../state/timelineLabels';
import { useTick } from './Ticking';

export interface TimelineProps {
  model: DashboardModel;
  now?: ReadonlySignal<number>;
}

export function Timeline({ model, now }: TimelineProps) {
  const markerRef = useRef<HTMLElement>(null);
  const elapsedRef = useRef<HTMLElement>(null);
  const currentId = model.active[0]?.id ?? null;
  const labelsRef = useRef<HTMLOListElement>(null);

  // Each label starts under its own bar; labels that would collide go on a second row (measured in the browser).
  useLayoutEffect(() => {
    const list = labelsRef.current;
    if (!list) return undefined;
    const place = () => {
      const items = Array.from(list.children) as HTMLElement[];
      const width = list.clientWidth;
      const spots = layoutLabels(items.map((li, i) => ({ leftPct: model.timeline[i].leftPct, widthPx: li.offsetWidth })), width);
      items.forEach((li, i) => {
        li.style.left = `${spots[i].xPx}px`;
        li.style.setProperty('--lane', String(spots[i].lane));
      });
      list.style.setProperty('--lanes', String(spots.reduce((most, s) => Math.max(most, s.lane + 1), 1)));
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(list);
    void document.fonts?.ready.then(place);
    return () => observer?.disconnect();
  }, [model.timeline]);

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
      <ol class="timeline__labels" ref={labelsRef} aria-label={t('dashboard.timelineAria')}>
        {model.timeline.map((item) => (
          <li key={item.id} style={{ left: item.left, borderColor: item.color || undefined }}>
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
