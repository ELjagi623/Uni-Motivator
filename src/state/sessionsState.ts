// Signals of the session list page: the chosen week, the selected row and the model rebuilt from the live data.

import { computed, signal } from '@preact/signals';
import { dashboardInputs } from './dashboardState';
import { activeNow, minuteBucket } from './now';
import { addWeeks, buildSessionsModel, sessionRowOf, type SessionRow, type SessionsModel } from './sessions';

/** The Monday the user navigated to; null = follow today's week. */
export const weekChoice = signal<number | null>(null);
/** The session whose details are open. */
export const selectedRowId = signal<string | null>(null);

/** Rebuilt when the data, the chosen week or the minute changes (never on every clock frame). */
export const sessionsModel = computed<SessionsModel>(() => {
  void minuteBucket.value;
  return buildSessionsModel(dashboardInputs.value, activeNow.peek(), weekChoice.value);
});

export const selectedRow = computed<SessionRow | null>(() => {
  const id = selectedRowId.value;
  if (id === null) return null;
  void minuteBucket.value;
  return sessionRowOf(dashboardInputs.value, id, activeNow.peek());
});

export function selectRow(id: string | null): void {
  selectedRowId.value = id;
}

export function goPrevWeek(): void {
  const model = sessionsModel.peek();
  if (model.canPrev) weekChoice.value = addWeeks(model.weekStartMs, -1);
}

export function goNextWeek(): void {
  const model = sessionsModel.peek();
  if (model.canNext) weekChoice.value = addWeeks(model.weekStartMs, 1);
}

export function goThisWeek(): void {
  weekChoice.value = null;
}

/** Jump to an academic year's classes: this week for the current year, else its last (archived) or first (upcoming) week. */
export function goToYear(year: number): void {
  const chip = sessionsModel.peek().years.find((y) => y.year === year);
  if (!chip) return;
  weekChoice.value = chip.jumpWeekMs;
  selectedRowId.value = null;
}

/** Test helper: back to the initial page state. */
export function resetSessionsState(): void {
  weekChoice.value = null;
  selectedRowId.value = null;
}
