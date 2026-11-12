// The 7-step first-run wizard (language, school and region, tuition, year dates, calendar, courses, preview): draft values, step guards, the live preview and the final config.
// Pure helpers (taking the draft and sessions as arguments) are exported for tests; the signals at the bottom
// bind them to the app state. All money maths is delegated to core.

import { computed, signal } from '@preact/signals';
import { checkSplitDate, formatMonthDay, parseMonthDay, type SplitCheckStatus } from '../core/academic';
import { buildPools, type Pool } from '../core/billing';
import { COURSE_COLORS, courseFromGroup, groupSessions, type CourseGroup } from '../core/courses';
import { formatMinor, getCurrency, majorToMinor, type CurrencyCode } from '../core/money';
import type { AcademicConfig, Course, Session, TuitionConfig } from '../core/types';
import { getRegionPreset, type RegionPreset } from '../data/regions';
import { calendarNames, resetCalendarState } from './calendars';
import { parseCreditsText } from './credits';
import { DEFAULT_CURRENCY, type AppConfig, type CalendarSource } from './config';
import { calendars, config, flushSaves, setConfig } from './data';
import { allSessions, billableOf } from './derived';
import { languageChoice } from './language';

export const TOTAL_STEPS = 7;
export type BillingPeriod = AcademicConfig['billingPeriod'];
export type RegionId = RegionPreset['id'];

export interface OnboardingDraft {
  /** 1..TOTAL_STEPS */
  step: number;
  school: string;
  region: RegionId;
  billingPeriod: BillingPeriod;
  currency: CurrencyCode;
  /** Tuition exactly as typed, in major units ("398,000"): the whole year, or semester 1 when billing per semester. */
  tuitionText: string;
  /** Semester 2's tuition as typed; null = no second semester was added (it then costs the same as semester 1). */
  tuition2Text: string | null;
  yearStart: string;
  splitDate: string;
  /** Group key -> checked. A group without an entry uses its suggested state. */
  selection: Record<string, boolean>;
  /** Group key -> credits as typed. */
  credits: Record<string, string>;
  /** Group key -> display name typed by the user. */
  names: Record<string, string>;
}

export function initialDraft(): OnboardingDraft {
  const preset = getRegionPreset('northern');
  return {
    step: 1,
    school: '',
    region: 'northern',
    billingPeriod: 'semester',
    currency: DEFAULT_CURRENCY,
    tuitionText: '',
    tuition2Text: null,
    yearStart: preset.yearStart,
    splitDate: preset.splitDate,
    selection: {},
    credits: {},
    names: {},
  };
}

/** Choosing a region fills in that region's default year start and split date. */
export function applyRegion(draft: OnboardingDraft, region: RegionId): OnboardingDraft {
  const preset = getRegionPreset(region);
  return { ...draft, region, yearStart: preset.yearStart, splitDate: preset.splitDate };
}

/** Tuition in integer minor units, or null when the text is not a number greater than zero. */
export function tuitionMinorOf(draft: Pick<OnboardingDraft, 'tuitionText'>): number | null {
  const minor = majorToMinor(draft.tuitionText);
  return minor !== null && minor > 0 ? minor : null;
}

/** Semester 2's tuition in minor units: null when it was not added, or is not a number greater than zero. */
export function tuition2MinorOf(draft: Pick<OnboardingDraft, 'tuition2Text'>): number | null {
  if (draft.tuition2Text === null) return null;
  const minor = majorToMinor(draft.tuition2Text);
  return minor !== null && minor > 0 ? minor : null;
}

/** The tuition step is complete: the first amount is valid, and so is the second one when it was added. */
export function tuitionComplete(draft: Pick<OnboardingDraft, 'tuitionText' | 'tuition2Text' | 'billingPeriod'>): boolean {
  if (tuitionMinorOf(draft) === null) return false;
  return draft.billingPeriod !== 'semester' || draft.tuition2Text === null || tuition2MinorOf(draft) !== null;
}

/**
 * The tuition document of the config: the first amount is the default for every pool; when billing per semester and a
 * second amount was given, every second-semester pool of `pools` gets that amount of its own.
 */
export function tuitionConfigOf(draft: OnboardingDraft, pools: readonly Pick<Pool, 'key' | 'semester'>[]): TuitionConfig {
  const first = tuitionMinorOf(draft);
  if (draft.billingPeriod !== 'semester') return { defaultMinor: first };
  const second = tuition2MinorOf(draft);
  const byPool: Record<string, number | null> = {};
  if (second !== null && second !== first) for (const pool of pools) if (pool.semester === 2) byPool[pool.key] = second;
  return { defaultMinor: first, byPool };
}

export function isValidMonthDay(text: string): boolean {
  try {
    parseMonthDay(text);
    return true;
  } catch {
    return false;
  }
}

export function isGroupSelected(draft: OnboardingDraft, group: CourseGroup): boolean {
  return draft.selection[group.key] ?? group.suggested;
}

function parseCredits(text: string | undefined): number | null {
  if (text === undefined) return null;
  const parsed = parseCreditsText(text);
  return parsed === undefined ? null : parsed;
}

/** True when the credits typed for a group are not empty and not a number greater than zero. */
export function creditsInvalid(text: string | undefined): boolean {
  return text !== undefined && parseCreditsText(text) === undefined;
}

/** The courses the user has ticked, with the typed names and credits. Colours follow the group order. */
export function selectedCourses(draft: OnboardingDraft, groups: readonly CourseGroup[]): Course[] {
  const out: Course[] = [];
  groups.forEach((group, index) => {
    if (!isGroupSelected(draft, group)) return;
    const name = draft.names[group.key]?.trim();
    out.push(courseFromGroup({ ...group, name: name ? name : group.name }, { credits: parseCredits(draft.credits[group.key]), colorIndex: index }));
  });
  return out;
}

/** Total class hours of a group with one decimal ("87.0"). */
export function groupHours(group: CourseGroup): string {
  return (group.totalSeconds / 3600).toFixed(1);
}

/** The colour a course gets when its group (at position `index` in the list) is ticked. */
export function groupColor(index: number): string {
  return COURSE_COLORS[index % COURSE_COLORS.length];
}

export function academicOf(draft: OnboardingDraft): AcademicConfig {
  return { yearStart: draft.yearStart, splitDate: draft.splitDate, billingPeriod: draft.billingPeriod };
}

// ------------------------------------------------------------------ preview

export interface PreviewPool {
  key: string;
  year: number;
  semester: 1 | 2 | null;
  sessions: number;
  /** Total class hours with one decimal ("87.0"). */
  hours: string;
  /** Cost per second in the currency's major unit with 4 decimals, e.g. "HK$1.2708"; null while tuition is not valid. */
  rate: string | null;
  /** Average cost of one session, e.g. "HK$13,724.14"; null while tuition is not valid. */
  average: string | null;
}

export interface SplitCheckView {
  year: number;
  status: SplitCheckStatus;
  /** The configured split date as MM-DD. */
  split: string;
  /** The longest gap between two sessions, as MM-DD. */
  gapFrom?: string;
  gapTo?: string;
  suggestedSplit?: string;
}

export interface Preview {
  courses: Course[];
  sessionCount: number;
  hours: string;
  pools: PreviewPool[];
  /** Cost per second: one value when all pools agree, otherwise "low – high". Null while tuition is not valid. */
  rate: string | null;
  average: string | null;
  splitChecks: SplitCheckView[];
}

const oneDecimal = (seconds: number): string => (seconds / 3600).toFixed(1);

function monthDayOf(ms: number): string {
  const d = new Date(ms);
  return formatMonthDay(d.getMonth() + 1, d.getDate());
}

function rangeText(values: readonly number[], render: (v: number) => string): string | null {
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? render(low) : `${render(low)} – ${render(high)}`;
}

/** What step 6's footer and step 7 show: counts, hours, cost per second and the split-date check. */
export function buildPreview(draft: OnboardingDraft, sessions: readonly Session[], groups: readonly CourseGroup[]): Preview {
  const courses = selectedCourses(draft, groups);
  const billable = billableOf(sessions, courses);
  const tuition = tuitionMinorOf(draft);
  const academic = academicOf(draft);
  const valid = isValidMonthDay(draft.yearStart) && isValidMonthDay(draft.splitDate);
  if (billable.length === 0 || !valid) {
    return { courses, sessionCount: 0, hours: '0.0', pools: [], rate: null, average: null, splitChecks: [] };
  }

  const firstPass = buildPools(billable, { academic, mode: 'duration', tuition: { defaultMinor: tuition } });
  const tuitionConfig = tuitionConfigOf(draft, firstPass);
  const pools = Object.keys(tuitionConfig.byPool ?? {}).length === 0 ? firstPass : buildPools(billable, { academic, mode: 'duration', tuition: tuitionConfig });
  const rates: number[] = [];
  const averages: number[] = [];
  const poolViews: PreviewPool[] = pools.map((pool) => {
    const rate = pool.averageRatePerSec / 100; // minor units per second -> major units per second
    const poolTuition = pool.tuitionMinor;
    const average = poolTuition === null ? null : Math.round(poolTuition / pool.sessions.length);
    if (poolTuition !== null) {
      rates.push(rate);
      averages.push(average as number);
    }
    return {
      key: pool.key,
      year: pool.year,
      semester: pool.semester,
      sessions: pool.sessions.length,
      hours: oneDecimal(pool.totalSeconds),
      rate: poolTuition === null ? null : `${currencySymbol(draft.currency)}${rate.toFixed(4)}`,
      average: average === null ? null : formatMinor(average, draft.currency),
    };
  });

  const totalSeconds = pools.reduce((sum, p) => sum + p.totalSeconds, 0);
  return {
    courses,
    sessionCount: billable.length,
    hours: oneDecimal(totalSeconds),
    pools: poolViews,
    rate: rangeText(rates, (v) => `${currencySymbol(draft.currency)}${v.toFixed(4)}`),
    average: rangeText(averages, (v) => formatMinor(v, draft.currency)),
    splitChecks: splitCheckViews(billable, academic),
  };
}

/** The split-date check of every academic year, as the text-ready views the wizard and the settings page show. */
export function splitCheckViews(sessions: readonly Session[], academic: AcademicConfig): SplitCheckView[] {
  return checkSplitDate(sessions, academic).map((c) => ({
    year: c.year,
    status: c.status,
    split: monthDayOf(c.splitMs),
    gapFrom: c.gapFromMs === undefined ? undefined : monthDayOf(c.gapFromMs),
    gapTo: c.gapToMs === undefined ? undefined : monthDayOf(c.gapToMs),
    suggestedSplit: c.suggestedSplit,
  }));
}

function currencySymbol(code: CurrencyCode): string {
  return getCurrency(code).symbol;
}

// ------------------------------------------------------------------ step guards

export interface StepContext {
  calendarCount: number;
  preview: Preview;
}

/** Whether "next" (or "finish" on the last step) is allowed on `step`. */
export function canProceed(step: number, draft: OnboardingDraft, ctx: StepContext): boolean {
  switch (step) {
    case 3:
      return tuitionComplete(draft);
    case 4:
      return isValidMonthDay(draft.yearStart) && isValidMonthDay(draft.splitDate);
    case 5:
      return ctx.calendarCount > 0;
    case 6:
      return ctx.preview.sessionCount > 0;
    case 7:
      return tuitionComplete(draft) && ctx.preview.sessionCount > 0;
    default:
      return true;
  }
}

// ------------------------------------------------------------------ the finished config

/** The `config` document written when onboarding is completed. Returns null when the draft is not complete. */
export function buildConfig(draft: OnboardingDraft, groups: readonly CourseGroup[], sources: readonly CalendarSource[], sessions: readonly Session[] = []): AppConfig | null {
  if (!tuitionComplete(draft)) return null;
  const courses = selectedCourses(draft, groups);
  if (courses.length === 0) return null;
  const academic = academicOf(draft);
  const pools = buildPools(billableOf(sessions, courses), { academic, mode: 'duration', tuition: { defaultMinor: tuitionMinorOf(draft) } });
  return {
    schemaVersion: 1,
    onboardingDone: true,
    school: draft.school.trim(),
    region: draft.region,
    currency: draft.currency,
    academic,
    billingMode: 'duration',
    // Per-semester billing keeps a per-pool table (a second semester's own amount goes in it); per-year billing has a single pool.
    tuition: tuitionConfigOf(draft, pools),
    courses,
    calendars: [...sources],
  };
}

// ------------------------------------------------------------------ app-bound state

export const draft = signal<OnboardingDraft>(initialDraft());
export const groups = computed<CourseGroup[]>(() => groupSessions(allSessions.value));
export const preview = computed<Preview>(() => buildPreview(draft.value, allSessions.value, groups.value));

export function updateDraft(patch: Partial<OnboardingDraft>): void {
  draft.value = { ...draft.value, ...patch };
}

export function chooseRegion(region: RegionId): void {
  draft.value = applyRegion(draft.value, region);
}

/** "+": add the second semester (an empty box to type its own amount in). */
export function addSecondSemester(): void {
  if (draft.value.tuition2Text === null) updateDraft({ tuition2Text: '' });
}

export function removeSecondSemester(): void {
  updateDraft({ tuition2Text: null });
}

export function setGroupSelected(key: string, selected: boolean): void {
  updateDraft({ selection: { ...draft.value.selection, [key]: selected } });
}

export function setGroupCredits(key: string, text: string): void {
  updateDraft({ credits: { ...draft.value.credits, [key]: text } });
}

export function setGroupName(key: string, text: string): void {
  updateDraft({ names: { ...draft.value.names, [key]: text } });
}

export function goToStep(step: number): void {
  updateDraft({ step: Math.min(TOTAL_STEPS, Math.max(1, step)) });
}

export const stepAllowsNext = computed<boolean>(() => canProceed(draft.value.step, draft.value, { calendarCount: calendars.value.length, preview: preview.value }));

export function nextStep(): void {
  if (draft.value.step < TOTAL_STEPS && stepAllowsNext.value) goToStep(draft.value.step + 1);
}

export function previousStep(): void {
  goToStep(draft.value.step - 1);
}

export function calendarSources(): CalendarSource[] {
  return calendars.value.map((c) => ({ id: c.id, name: calendarNames.value[c.id] ?? c.id }));
}

/** Write the finished config (saved at once) and leave the wizard. Returns false when something is still missing. */
export async function finishOnboarding(): Promise<boolean> {
  const built = buildConfig(draft.value, groups.value, calendarSources(), allSessions.value);
  if (!built) return false;
  // The language chosen in step 1 and an interface size chosen earlier are not part of the wizard's draft: keep them.
  const keep = config.peek();
  setConfig({ ...built, language: languageChoice.peek(), ...(typeof keep.uiScale === 'number' ? { uiScale: keep.uiScale } : {}) });
  await flushSaves();
  draft.value = initialDraft();
  resetCalendarState();
  return true;
}
