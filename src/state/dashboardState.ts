// Signals around the dashboard model: its inputs, the model itself (rebuilt only when it can have changed) and the
// user's choice among overlapping classes.
//
//  - `dashboardInputs` covers every academic year (statistics, the session list and the share card use it).
//  - `focusInputs` is the same data restricted to the focus year (core `focusYearOf`): the main screen, the tab title
//    and the slacking page show one academic year at a time, so an old year never leaks into "this semester".

import { computed, signal } from '@preact/signals';
import { academicYearOf } from '../core/academic';
import { buildDashboardModel, marksOf, type DashboardInputs, type DashboardModel } from './dashboard';
import { billableSessions, courses as coursesSignal, currency as currencySignal, pools as poolsSignal } from './derived';
import { activeNow } from './now';
import { slackRecords } from './slackRecords';
import { activeMarks } from './source';
import { academicConfig, focusYear, yearInfos } from './years';

export const dashboardInputs = computed<DashboardInputs>(() => ({
  sessions: billableSessions.value,
  courses: coursesSignal.value,
  pools: poolsSignal.value,
  marks: marksOf(activeMarks.value),
  slacks: slackRecords.value,
  currency: currencySignal.value,
  academic: academicConfig.value,
}));

/** The data of the focus academic year only (the same object as `dashboardInputs` while there is just one year). */
export const focusInputs = computed<DashboardInputs>(() => {
  const all = dashboardInputs.value;
  const year = focusYear.value;
  if (year === null || yearInfos.value.length <= 1) return all;
  const cfg = academicConfig.value;
  const sessions = all.sessions.filter((s) => academicYearOf(s.startMs, cfg) === year);
  const ids = new Set(sessions.map((s) => s.id));
  return {
    ...all,
    sessions,
    pools: all.pools.filter((p) => p.year === year),
    slacks: all.slacks.filter((r) => ids.has(r.sessionId)),
  };
});

let modelCache: { inputs: DashboardInputs; model: DashboardModel } | null = null;

/** The current dashboard model. The same object is returned until the status can change or the data changes. */
export const dashboardModel = computed<DashboardModel>(() => {
  const inputs = focusInputs.value;
  const nowMs = activeNow.value;
  if (modelCache && modelCache.inputs === inputs && nowMs >= modelCache.model.validFromMs && nowMs < modelCache.model.validUntilMs) return modelCache.model;
  const model = buildDashboardModel(inputs, nowMs);
  modelCache = { inputs, model };
  return model;
});

/** Which of several overlapping sessions the user chose to look at (null = the primary one). */
export const selectedSessionId = signal<string | null>(null);

export function chooseSession(id: string | null): void {
  selectedSessionId.value = id;
}
