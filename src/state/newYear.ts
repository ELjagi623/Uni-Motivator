// Starting a new academic year: import the new year's calendar, confirm which of its events are classes (the courses
// that are not yet known), set the tuition of the new year's pools, and see what the change does to the unit prices.
//
// Nothing is "created" besides ordinary data: the academic year follows from the sessions (core/years.ts). The calendar
// file is stored on the server as soon as it is chosen (like any other import), but the courses and tuition only enter
// `config` when the user confirms; cancelling deletes the files this import added. Old years keep their marks and
// slacking records (they are keyed by session id) and become read-only archives as soon as the new year starts.

import { computed, signal } from '@preact/signals';
import { buildPools } from '../core/billing';
import { assignCourses, courseFromGroup, groupSessions, type CourseGroup } from '../core/courses';
import { formatAmountMinor, isCurrencyCode, type CurrencyCode } from '../core/money';
import type { Course, Session } from '../core/types';
import { addCalendars, removeCalendarFromSettings, type ImportItem, type ImportReport } from './calendars';
import { DEFAULT_CURRENCY, type AppConfig } from './config';
import { calendars, config, flushSaves, setConfig } from './data';
import { allSessions, billableOf, billingConfigOf, pools as savedPools, sessionsOfFiles } from './derived';
import { parseCreditsText } from './credits';
import {
  buildDraftConfig,
  draftFromConfig,
  parseTuitionText,
  poolLabelOf,
  poolsFor,
  rateChanges,
  type RateChange,
} from './settings';

export interface NewYearFlow {
  /** Calendars this import added (deleted again when the user cancels). */
  addedIds: string[];
  report: ImportReport;
  /** Group key -> ticked. A group without an entry uses its suggested state. */
  selection: Record<string, boolean>;
  /** Group key -> credits as typed. */
  credits: Record<string, string>;
  /** Group key -> display name as typed. */
  names: Record<string, string>;
  /** New pool key -> tuition as typed (major units). A pool without an entry shows the suggested tuition. */
  tuitionTexts: Record<string, string>;
}

export interface NewPoolField {
  key: string;
  label: string;
  /** The typed text, or the suggestion (the tuition of the latest pool that has one). */
  text: string;
  invalid: boolean;
}

export interface NewYearPlan {
  /** Events of the new calendar(s) that no known course covers, grouped as the recognition page groups them. */
  groups: CourseGroup[];
  isSelected: (group: CourseGroup) => boolean;
  /** The courses that would be added. */
  newCourses: Course[];
  /** The tuition pools that exist only after the import (one per new semester / year). */
  newPools: NewPoolField[];
  /** Price changes of pools that already existed (e.g. new courses in an existing semester). */
  rateChanges: RateChange[];
  /** The config that confirming would save. */
  candidate: AppConfig;
  /** Sessions the new calendar(s) bring in. */
  newSessionCount: number;
  hasInvalidCredits: boolean;
  hasInvalidTuition: boolean;
  canConfirm: boolean;
}

const currencyOf = (cfg: AppConfig): CurrencyCode => (isCurrencyCode(cfg.currency) ? cfg.currency : DEFAULT_CURRENCY);

function creditsOf(flow: NewYearFlow, group: CourseGroup): number | null {
  const parsed = parseCreditsText(flow.credits[group.key] ?? '');
  return parsed === undefined ? null : parsed;
}

/**
 * Pure: what the import would do. `oldSessions` are the sessions before the import, `allSessionsNow` all of them
 * (merged by session id, so a class the new file repeats is not counted twice).
 */
export function planNewYear(flow: NewYearFlow, base: AppConfig, oldSessions: readonly Session[], allSessionsNow: readonly Session[]): NewYearPlan {
  const known = base.courses ?? [];
  const oldIds = new Set(oldSessions.map((s) => s.id));
  const newSessions = allSessionsNow.filter((s) => !oldIds.has(s.id));
  const covered = assignCourses(newSessions, known);
  const groups = groupSessions(newSessions.filter((s) => !covered.has(s.id)));
  const isSelected = (g: CourseGroup): boolean => flow.selection[g.key] ?? g.suggested;
  const newCourses: Course[] = [];
  groups.forEach((g, index) => {
    if (!isSelected(g)) return;
    const name = flow.names[g.key]?.trim();
    newCourses.push(courseFromGroup({ ...g, name: name ? name : g.name }, { credits: creditsOf(flow, g), colorIndex: known.length + index }));
  });
  const withCourses: AppConfig = { ...base, courses: [...known, ...newCourses] };

  const billable = billableOf(allSessionsNow, withCourses.courses ?? []);
  const poolsBefore = poolsFor(base, billableOf(oldSessions, known));
  const oldKeys = new Set(poolsBefore.map((p) => p.key));
  const poolsAfter = billable.length > 0 ? buildPools(billable, billingConfigOf(withCourses)) : [];
  const newPoolObjs = poolsAfter.filter((p) => !oldKeys.has(p.key));

  // Suggested tuition for a new pool: the tuition of the latest existing pool that has one, else the default.
  const latest = [...poolsBefore].reverse().find((p) => p.tuitionMinor !== null);
  const suggestionMinor = latest?.tuitionMinor ?? withCourses.tuition?.defaultMinor ?? null;
  const suggestionText = suggestionMinor === null ? '' : formatAmountMinor(suggestionMinor);
  const typed = (key: string): string => (key in flow.tuitionTexts ? flow.tuitionTexts[key] : suggestionText);
  const newPools: NewPoolField[] = newPoolObjs.map((p) => ({
    key: p.key,
    label: poolLabelOf(p.year, p.semester),
    text: typed(p.key),
    invalid: parseTuitionText(typed(p.key)) === undefined,
  }));

  const poolTexts: Record<string, string> = {};
  for (const p of newPoolObjs) poolTexts[p.key] = typed(p.key);
  const draft = { ...draftFromConfig(withCourses), poolTexts };
  const candidate = buildDraftConfig(withCourses, draft, newPoolObjs.map((p) => p.key));

  const candidatePools = billable.length > 0 ? buildPools(billable, billingConfigOf(candidate)) : [];
  const changes = rateChanges(
    poolsBefore,
    currencyOf(base),
    candidatePools.filter((p) => oldKeys.has(p.key)),
    currencyOf(candidate),
    { oldMode: base.billingMode, newMode: candidate.billingMode, courseLabel: (id) => (candidate.courses ?? []).find((c) => c.id === id)?.code ?? (candidate.courses ?? []).find((c) => c.id === id)?.name ?? '' },
  );

  const hasInvalidCredits = groups.some((g) => isSelected(g) && parseCreditsText(flow.credits[g.key] ?? '') === undefined);
  const hasInvalidTuition = newPools.some((p) => p.invalid);
  return {
    groups,
    isSelected,
    newCourses,
    newPools,
    rateChanges: changes,
    candidate,
    newSessionCount: newSessions.length,
    hasInvalidCredits,
    hasInvalidTuition,
    canConfirm: newSessions.length > 0 && (newCourses.length > 0 || covered.size > 0) && !hasInvalidCredits && !hasInvalidTuition,
  };
}

// ------------------------------------------------------------------ app-bound state

export const newYear = signal<NewYearFlow | null>(null);
export const newYearBusy = signal(false);
/** What the last import / confirmation did, for the status line of the year card. */
export const newYearResult = signal<{ kind: 'imported' | 'nothing' | 'done' | 'cancelled'; added?: number } | null>(null);
export const newYearReport = signal<ImportReport | null>(null);

export const newYearPlan = computed<NewYearPlan | null>(() => {
  const flow = newYear.value;
  if (!flow) return null;
  const added = new Set(flow.addedIds);
  const oldSessions = sessionsOfFiles(calendars.value.filter((c) => !added.has(c.id)));
  return planNewYear(flow, config.value, oldSessions, allSessions.value);
});

/** The user chose the new year's calendar file(s). */
export async function startNewYear(items: readonly ImportItem[]): Promise<void> {
  newYearResult.value = null;
  newYearBusy.value = true;
  try {
    const before = new Set(calendars.peek().map((c) => c.id));
    const report = await addCalendars(items);
    newYearReport.value = report;
    const addedIds = calendars.peek().filter((c) => !before.has(c.id)).map((c) => c.id);
    // A file whose classes are all known already adds nothing: it is dropped again instead of starting a flow.
    const oldIds = new Set(sessionsOfFiles(calendars.peek().filter((c) => !addedIds.includes(c.id))).map((x) => x.id));
    const brings = allSessions.peek().some((x) => !oldIds.has(x.id));
    if (addedIds.length === 0 || !brings) {
      for (const id of addedIds) await removeCalendarFromSettings(id).catch(() => undefined);
      newYearResult.value = { kind: 'nothing' };
      return;
    }
    newYear.value = { addedIds, report, selection: {}, credits: {}, names: {}, tuitionTexts: {} };
    newYearResult.value = { kind: 'imported', added: addedIds.length };
  } finally {
    newYearBusy.value = false;
  }
}

function patchFlow(patch: Partial<NewYearFlow>): void {
  const flow = newYear.peek();
  if (flow) newYear.value = { ...flow, ...patch };
}

export function setNewGroupSelected(key: string, on: boolean): void {
  patchFlow({ selection: { ...(newYear.peek()?.selection ?? {}), [key]: on } });
}
export function setNewGroupCredits(key: string, text: string): void {
  patchFlow({ credits: { ...(newYear.peek()?.credits ?? {}), [key]: text } });
}
export function setNewGroupName(key: string, text: string): void {
  patchFlow({ names: { ...(newYear.peek()?.names ?? {}), [key]: text } });
}
export function setNewPoolTuition(key: string, text: string): void {
  patchFlow({ tuitionTexts: { ...(newYear.peek()?.tuitionTexts ?? {}), [key]: text } });
}

/** Save the new courses and tuition. Returns false when the plan is not ready. */
export async function confirmNewYear(): Promise<boolean> {
  const plan = newYearPlan.peek();
  if (!plan || !plan.canConfirm) return false;
  const addedIds = newYear.peek()?.addedIds ?? [];
  setConfig(plan.candidate);
  newYear.value = null;
  await flushSaves();
  newYearResult.value = { kind: 'done', added: addedIds.length };
  return true;
}

/** Throw the import away: the calendar files this import added are deleted again. */
export async function cancelNewYear(): Promise<void> {
  const flow = newYear.peek();
  if (!flow) return;
  newYear.value = null;
  for (const id of flow.addedIds) {
    if (calendars.peek().some((c) => c.id === id)) await removeCalendarFromSettings(id).catch(() => undefined);
  }
  newYearResult.value = { kind: 'cancelled' };
}

/** The pools that exist (used by the year card to say how many new ones the import brings). */
export const existingPoolCount = computed(() => savedPools.value.length);

export function resetNewYearState(): void {
  newYear.value = null;
  newYearBusy.value = false;
  newYearResult.value = null;
  newYearReport.value = null;
}

export { groupHours } from './onboarding';
