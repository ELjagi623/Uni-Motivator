// Signals around the dashboard model: its inputs, the model itself (rebuilt only when it can have changed) and the
// user's choice among overlapping classes.

import { computed, signal } from '@preact/signals';
import { buildDashboardModel, marksOf, type DashboardInputs, type DashboardModel } from './dashboard';
import { billableSessions, courses as coursesSignal, currency as currencySignal, pools as poolsSignal } from './derived';
import { activeNow } from './now';
import { slackRecords } from './slackRecords';
import { activeMarks } from './source';

export const dashboardInputs = computed<DashboardInputs>(() => ({
  sessions: billableSessions.value,
  courses: coursesSignal.value,
  pools: poolsSignal.value,
  marks: marksOf(activeMarks.value),
  slacks: slackRecords.value,
  currency: currencySignal.value,
}));

let modelCache: { inputs: DashboardInputs; model: DashboardModel } | null = null;

/** The current dashboard model. The same object is returned until the status can change or the data changes. */
export const dashboardModel = computed<DashboardModel>(() => {
  const inputs = dashboardInputs.value;
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

