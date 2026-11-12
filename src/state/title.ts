// The browser tab title: "HK$2,687 · MFIN7001" while in class, "🐟 HK$3.51" while slacking, the app name otherwise.

import { effect } from '@preact/signals';
import { formatMinorWhole } from '../core/money';
import { t } from '../i18n';
import { liveAt, shownView } from './dashboard';
import { dashboardModel, selectedSessionId } from './dashboardState';
import { slackContextOf, slackTitleOf, slackUi } from './slack';
import { activeNow } from './now';

/** The title for the current state (reads signals, so it can be used inside an effect). */
export function computeTitle(): string {
  const nowMs = activeNow.value;
  const ui = slackUi.value;
  if (ui?.mode === 'slacking') {
    const ctx = slackContextOf(ui.recordId);
    if (ctx) return slackTitleOf(ctx, nowMs);
  }
  const model = dashboardModel.value;
  if (model.kind === 'in-class') {
    const view = shownView(model, selectedSessionId.value);
    if (view) return `${formatMinorWhole(liveAt(model, view.id, nowMs).sessionConsumedMinor, model.currency)} · ${view.label}`;
  }
  return t('app.title');
}

/** Keep `document.title` up to date. Returns a stop function. */
export function startTitleUpdates(): () => void {
  return effect(() => {
    const title = computeTitle();
    if (document.title !== title) document.title = title;
  });
}
