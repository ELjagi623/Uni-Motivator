// The basic settings page: tuition, billing period, currency, academic-year start and split date.
//
// The page edits a *draft*. Nothing is saved while typing. "Save" builds the candidate config and asks core what the
// unit price would be (`buildPools`); when any price changes the user must confirm "unit price will change from X to
// Y" first; cancelling sends nothing. All money maths (unit prices, pools) is core's; this file parses the typed
// amounts (`majorToMinor`) and compares the old and the new pools.

import { computed, signal } from '@preact/signals';
import { buildPools, type Pool } from '../core/billing';
import { formatAmountMinor, isCurrencyCode, majorToMinor, type CurrencyCode } from '../core/money';
import type { AcademicConfig, BillingMode, Course, TuitionConfig } from '../core/types';
import { t } from '../i18n';
import { DEFAULT_CURRENCY, defaultAcademic, type AppConfig } from './config';
import { parseCreditsText } from './credits';
import { config, flushSaves, setConfig } from './data';
import { rateText } from './dashboard';
import { billableSessions, billingConfigOf, pools as savedPools } from './derived';
import { isValidMonthDay, splitCheckViews, type SplitCheckView } from './onboarding';
import { yearInfos } from './years';

export type BillingPeriod = AcademicConfig['billingPeriod'];

export interface SettingsDraft {
  billingPeriod: BillingPeriod;
  currency: CurrencyCode;
  yearStart: string;
  splitDate: string;
  /** Pool key -> tuition as typed (major units). Only pools the user has edited have an entry. */
  poolTexts: Record<string, string>;
  /** Billing mode: the same price for every class hour, or weighted by each course's credits. */
  billingMode: BillingMode;
  /** Course id -> credits as typed. Only courses the user has edited have an entry. */
  creditTexts: Record<string, string>;
}

export interface SettingsErrors {
  yearStart: boolean;
  splitDate: boolean;
  /** Pool keys whose typed tuition is not a number greater than zero (an empty field means "not set" and is fine). */
  pools: string[];
  /** Course ids whose typed credits are not a number greater than zero (an empty field means "not set" and is fine). */
  credits: string[];
}

export interface CourseField {
  id: string;
  /** Course code, or the name when there is no code. */
  label: string;
  /** The course name when it adds something to the label. */
  subtitle: string;
  /** What the input shows: the typed text, or the saved credits (empty when not set). */
  text: string;
  invalid: boolean;
}

export interface PoolField {
  key: string;
  year: number;
  semester: 1 | 2 | null;
  /** "2026 学年 · 第 1 学期" in the interface language. */
  label: string;
  /** What the input shows: the typed text, or the saved amount (empty when the tuition is not set). */
  text: string;
  unset: boolean;
  invalid: boolean;
  /** True for a pool of an archived academic year: its tuition can no longer be edited. */
  readOnly: boolean;
}

export interface RateChange {
  poolKey: string;
  poolLabel: string;
  /** Set (only in credit mode) when the change is about one course's unit price: the course's id. */
  courseId?: string;
  /** Old unit price ("HK$0.5420"), or null when the old pool had no tuition. */
  fromText: string | null;
  /** New unit price, or null when the new tuition is not set. */
  toText: string | null;
}

export type SaveOutcome = 'saved' | 'needs-confirmation' | 'invalid' | 'unchanged';

// ------------------------------------------------------------------ pure helpers

export function draftFromConfig(cfg: AppConfig): SettingsDraft {
  const academic = cfg.academic ?? defaultAcademic();
  return {
    billingPeriod: academic.billingPeriod,
    currency: isCurrencyCode(cfg.currency) ? cfg.currency : DEFAULT_CURRENCY,
    yearStart: academic.yearStart,
    splitDate: academic.splitDate,
    poolTexts: {},
    billingMode: cfg.billingMode === 'credit' ? 'credit' : 'duration',
    creditTexts: {},
  };
}

export function poolLabelOf(year: number, semester: 1 | 2 | null): string {
  return semester === null ? t('dashboard.poolYear', { year }) : t('dashboard.poolSemester', { year, n: semester });
}

/** Tuition typed in major units: '' -> null (not set), a number greater than zero -> minor units, anything else -> undefined. */
export function parseTuitionText(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const minor = majorToMinor(text);
  return minor !== null && minor > 0 ? minor : undefined;
}

export function settingsErrors(draft: SettingsDraft, poolKeys: readonly string[], courseIds: readonly string[] = []): SettingsErrors {
  return {
    yearStart: !isValidMonthDay(draft.yearStart),
    splitDate: !isValidMonthDay(draft.splitDate),
    pools: poolKeys.filter((key) => key in draft.poolTexts && parseTuitionText(draft.poolTexts[key]) === undefined),
    credits: courseIds.filter((id) => id in draft.creditTexts && parseCreditsText(draft.creditTexts[id]) === undefined),
  };
}

export function hasErrors(errors: SettingsErrors): boolean {
  return errors.yearStart || errors.splitDate || errors.pools.length > 0 || errors.credits.length > 0;
}

function academicOfDraft(draft: SettingsDraft): AcademicConfig {
  return { yearStart: draft.yearStart, splitDate: draft.splitDate, billingPeriod: draft.billingPeriod };
}

/**
 * The config the draft would produce. Invalid typed tuitions are ignored (the saved value stays); the caller checks
 * `settingsErrors` before saving. `poolKeys` are the keys of the pools the draft's academic settings give.
 *
 * - The default tuition (`defaultMinor`) is kept. Switching between per-semester and per-year billing drops the old
 *   per-pool amounts (their keys do not exist any more); the preview then shows what that does to the unit price.
 * - A pool the user typed into gets its own entry in `byPool` (empty = not set); an entry equal to the default is dropped.
 */
export function buildDraftConfig(base: AppConfig, draft: SettingsDraft, poolKeys: readonly string[]): AppConfig {
  const baseAcademic = base.academic ?? defaultAcademic();
  const samePeriod = baseAcademic.billingPeriod === draft.billingPeriod;
  const baseTuition: TuitionConfig = base.tuition ?? { defaultMinor: null };
  const edits: Record<string, number | null> = {};
  for (const key of poolKeys) {
    if (!(key in draft.poolTexts)) continue;
    const parsed = parseTuitionText(draft.poolTexts[key]);
    if (parsed !== undefined) edits[key] = parsed;
  }
  let tuition: TuitionConfig;
  if (samePeriod && Object.keys(edits).length === 0) {
    tuition = baseTuition;
  } else {
    const byPool: Record<string, number | null> = { ...(samePeriod ? baseTuition.byPool ?? {} : {}) };
    for (const [key, value] of Object.entries(edits)) {
      if (value === baseTuition.defaultMinor) delete byPool[key];
      else byPool[key] = value;
    }
    tuition = draft.billingPeriod === 'semester' || Object.keys(byPool).length > 0 ? { defaultMinor: baseTuition.defaultMinor, byPool } : { defaultMinor: baseTuition.defaultMinor };
  }
  return { ...base, currency: draft.currency, academic: academicOfDraft(draft), tuition, billingMode: draft.billingMode, courses: coursesWithCredits(base.courses ?? [], draft) };
}

/** The courses with the credits the user typed (invalid texts are ignored; the caller checks `settingsErrors`). */
export function coursesWithCredits(courses: readonly Course[], draft: Pick<SettingsDraft, 'creditTexts'>): Course[] {
  if (Object.keys(draft.creditTexts).length === 0) return courses as Course[]; // nothing typed: the same array
  return courses.map((course) => {
    if (!(course.id in draft.creditTexts)) return course;
    const parsed = parseCreditsText(draft.creditTexts[course.id]);
    return parsed === undefined || parsed === course.credits ? course : { ...course, credits: parsed };
  });
}

/** True when the candidate differs from the saved config in anything this page edits. */
export function isDirty(base: AppConfig, candidate: AppConfig): boolean {
  const pick = (c: AppConfig) => {
    const tuition = c.tuition ?? { defaultMinor: null };
    const byPool = Object.entries(tuition.byPool ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const credits = (c.courses ?? []).map((course) => [course.id, course.credits]);
    return JSON.stringify([c.currency ?? DEFAULT_CURRENCY, c.academic ?? defaultAcademic(), tuition.defaultMinor, byPool, c.billingMode === 'credit' ? 'credit' : 'duration', credits]);
  };
  return pick(base) !== pick(candidate);
}

/** Pools of the configured courses' sessions under `cfg` (empty when the academic dates are not valid). */
export function poolsFor(cfg: AppConfig, sessions: ReturnType<typeof billableSessions.peek>): Pool[] {
  const academic = cfg.academic ?? defaultAcademic();
  if (sessions.length === 0 || !isValidMonthDay(academic.yearStart) || !isValidMonthDay(academic.splitDate)) return [];
  return buildPools(sessions, billingConfigOf(cfg));
}

/** Total tuition / total seconds over pools whose tuition is set, as unit-price text (null when none is set). */
function overallRateText(pools: readonly Pool[], currency: CurrencyCode): string | null {
  let tuition = 0;
  let seconds = 0;
  for (const p of pools) {
    if (p.tuitionMinor === null) continue;
    tuition += p.tuitionMinor;
    seconds += p.totalSeconds;
  }
  return seconds > 0 ? rateText(tuition / seconds, currency) : null;
}

/**
 * Which unit prices change? One entry per new pool whose unit price (or currency / tuition) differs from the pool with
 * the same key before; when there is no such pool (per-semester <-> per-year) the old overall price is compared.
 * An empty list means the save does not change any price.
 */
export interface RateChangeOptions {
  oldMode?: BillingMode;
  newMode?: BillingMode;
  /** Name of a course for the per-course lines of credit mode. */
  courseLabel?: (courseId: string) => string;
}

/** Unit price per course within a pool (every class of a course has the same price inside one pool). */
function courseRates(pool: Pool): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of pool.sessions) {
    const key = s.courseId ?? '';
    if (!out.has(key)) out.set(key, s.ratePerSec);
  }
  return out;
}

export function rateChanges(
  oldPools: readonly Pool[],
  oldCurrency: CurrencyCode,
  newPools: readonly Pool[],
  newCurrency: CurrencyCode,
  options: RateChangeOptions = {},
): RateChange[] {
  const changes: RateChange[] = [];
  const oldOverall = overallRateText(oldPools, oldCurrency);
  const creditInvolved = options.oldMode === 'credit' || options.newMode === 'credit';
  for (const pool of newPools) {
    const before = oldPools.find((p) => p.key === pool.key);
    // Credit mode: every course has its own unit price, so the change is listed course by course.
    if (creditInvolved && before && before.tuitionMinor !== null && pool.tuitionMinor !== null) {
      const oldRates = courseRates(before);
      for (const [courseId, rate] of courseRates(pool)) {
        const oldRate = oldRates.get(courseId);
        const fromText = oldRate === undefined ? null : rateText(oldRate, oldCurrency);
        const toText = rateText(rate, newCurrency);
        if (fromText !== toText) {
          const course = options.courseLabel?.(courseId) ?? '';
          const poolLabel = poolLabelOf(pool.year, pool.semester);
          changes.push({ poolKey: `${pool.key}:${courseId}`, poolLabel: course ? `${poolLabel} · ${course}` : poolLabel, courseId, fromText, toText });
        }
      }
      continue;
    }
    const fromText = before ? (before.tuitionMinor === null ? null : rateText(before.averageRatePerSec, oldCurrency)) : oldOverall;
    const toText = pool.tuitionMinor === null ? null : rateText(pool.averageRatePerSec, newCurrency);
    const tuitionChanged = before ? before.tuitionMinor !== pool.tuitionMinor : false;
    if (fromText !== toText || tuitionChanged) changes.push({ poolKey: pool.key, poolLabel: poolLabelOf(pool.year, pool.semester), fromText, toText });
  }
  return changes;
}

/** "单价将从 X 变为 Y / 秒" for one change (optionally prefixed with the pool's name). */
export function rateChangeText(change: RateChange, withPool: boolean): string {
  let text: string;
  if (change.toText === null) text = t('settings.confirm.rateToUnset', { from: change.fromText ?? '' });
  else if (change.fromText === null) text = t('settings.confirm.rateFromUnset', { to: change.toText });
  else text = t('settings.confirm.rate', { from: change.fromText, to: change.toText });
  return withPool ? t('settings.confirm.pool', { pool: change.poolLabel, text }) : text;
}

// ------------------------------------------------------------------ state

/** The draft; null while the page shows the saved settings unchanged. */
export const settingsDraft = signal<SettingsDraft | null>(null);

export const currentDraft = computed<SettingsDraft>(() => settingsDraft.value ?? draftFromConfig(config.value));

export interface SettingsView {
  draft: SettingsDraft;
  /** The config the draft would save (the saved one when nothing was edited). */
  candidate: AppConfig;
  errors: SettingsErrors;
  dirty: boolean;
  /** One field per tuition pool of the draft's billing period. */
  pools: PoolField[];
  /** One credits field per confirmed course. */
  courses: CourseField[];
  splitChecks: SplitCheckView[];
}

export const settingsView = computed<SettingsView>(() => {
  const saved = config.value;
  const draft = currentDraft.value;
  const sessions = billableSessions.value;
  // While a date is half typed the pool fields keep following the saved dates, so that they do not flicker away.
  const savedAcademic = saved.academic ?? defaultAcademic();
  const valid = isValidMonthDay(draft.yearStart) && isValidMonthDay(draft.splitDate);
  const poolDraft: SettingsDraft = valid ? draft : { ...draft, yearStart: savedAcademic.yearStart, splitDate: savedAcademic.splitDate };
  // Pool keys depend on the academic dates and the billing period only, not on the tuition.
  const poolKeys = poolsFor(buildDraftConfig(saved, { ...poolDraft, poolTexts: {} }, []), sessions).map((p) => p.key);
  const savedCourses = saved.courses ?? [];
  const errors = settingsErrors(draft, poolKeys, savedCourses.map((c) => c.id));
  const candidate = buildDraftConfig(saved, draft, poolKeys);
  const courseFields: CourseField[] = savedCourses.map((c) => ({
    id: c.id,
    label: c.code ?? c.name,
    subtitle: c.code && c.name !== c.code ? c.name.replace(c.code, '').trim() : '',
    text: c.id in draft.creditTexts ? draft.creditTexts[c.id] : c.credits === null ? '' : String(c.credits),
    invalid: errors.credits.includes(c.id),
  }));
  const draftPools = poolsFor(buildDraftConfig(saved, poolDraft, poolKeys), sessions);
  const archivedYears = new Set(yearInfos.value.filter((y) => y.role === 'archived').map((y) => y.year));
  const pools: PoolField[] = draftPools.map((p) => ({
    key: p.key,
    year: p.year,
    semester: p.semester,
    label: poolLabelOf(p.year, p.semester),
    text: p.key in draft.poolTexts ? draft.poolTexts[p.key] : p.tuitionMinor === null ? '' : formatAmountMinor(p.tuitionMinor),
    unset: p.tuitionMinor === null,
    invalid: errors.pools.includes(p.key),
    readOnly: archivedYears.has(p.year),
  }));
  return {
    draft,
    candidate,
    errors,
    dirty: isDirty(saved, candidate),
    pools,
    courses: courseFields,
    splitChecks: valid && sessions.length > 0 ? splitCheckViews(sessions, academicOfDraft(draft)) : [],
  };
});

/** Pools of the saved config whose tuition has not been set. The shell shows a hint while there are any. */
export const unsetPools = computed(() => savedPools.value.filter((p) => p.tuitionMinor === null).map((p) => ({ key: p.key, label: poolLabelOf(p.year, p.semester) })));

/** The text of the shell's "tuition not set" hint, or null when every pool has a tuition. */
export const unsetBannerText = computed<string | null>(() => {
  const unset = unsetPools.value;
  return unset.length === 0 ? null : t('shell.unsetBanner', { pools: unset.map((p) => p.label).join(t('list.separator')) });
});

export function editDraft(patch: Partial<SettingsDraft>): void {
  const next = { ...currentDraft.peek(), ...patch };
  // Per-pool amounts belong to one billing period; a different period starts with fresh fields.
  if (patch.billingPeriod !== undefined && patch.billingPeriod !== currentDraft.peek().billingPeriod && patch.poolTexts === undefined) next.poolTexts = {};
  settingsDraft.value = next;
}

export function setPoolText(key: string, text: string): void {
  if (settingsView.peek().pools.find((p) => p.key === key)?.readOnly) return; // archived years are read-only
  editDraft({ poolTexts: { ...currentDraft.peek().poolTexts, [key]: text } });
}

export function setCreditText(courseId: string, text: string): void {
  editDraft({ creditTexts: { ...currentDraft.peek().creditTexts, [courseId]: text } });
}

export function setBillingMode(mode: BillingMode): void {
  editDraft({ billingMode: mode });
}

export function resetDraft(): void {
  settingsDraft.value = null;
  pendingChanges.value = null;
}

/** The confirmation dialog: set while the user has to confirm the unit-price change. */
export const pendingChanges = signal<RateChange[] | null>(null);

/** What `save` would change right now (empty = no price changes). */
export function currentRateChanges(): RateChange[] {
  const view = settingsView.peek();
  const sessions = billableSessions.peek();
  const saved = config.peek();
  const oldCurrency = isCurrencyCode(saved.currency) ? saved.currency : DEFAULT_CURRENCY;
  const names = new Map((view.candidate.courses ?? []).map((c) => [c.id, c.code ?? c.name]));
  return rateChanges(savedPools.peek(), oldCurrency, poolsFor(view.candidate, sessions), view.draft.currency, {
    oldMode: saved.billingMode === 'credit' ? 'credit' : 'duration',
    newMode: view.draft.billingMode,
    courseLabel: (id) => names.get(id) ?? '',
  });
}

async function commit(candidate: AppConfig): Promise<void> {
  setConfig(candidate);
  settingsDraft.value = null;
  pendingChanges.value = null;
  await flushSaves();
}

/**
 * "Save": nothing happens while the draft is invalid or unchanged; when a unit price would change the confirmation
 * dialog opens instead of saving; otherwise the config is saved at once.
 */
export async function saveSettings(): Promise<SaveOutcome> {
  const view = settingsView.peek();
  if (hasErrors(view.errors)) return 'invalid';
  if (!view.dirty) return 'unchanged';
  const changes = currentRateChanges();
  if (changes.length > 0) {
    pendingChanges.value = changes;
    return 'needs-confirmation';
  }
  await commit(view.candidate);
  return 'saved';
}

/** The user confirmed the dialog. */
export async function confirmSave(): Promise<void> {
  const view = settingsView.peek();
  if (hasErrors(view.errors) || !view.dirty) {
    pendingChanges.value = null;
    return;
  }
  await commit(view.candidate);
}

/** The user cancelled the dialog: nothing is sent, the draft stays as it is. */
export function cancelSave(): void {
  pendingChanges.value = null;
}

/** Test helper. */
export function resetSettingsState(): void {
  settingsDraft.value = null;
  pendingChanges.value = null;
}
