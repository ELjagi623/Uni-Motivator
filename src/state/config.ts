// Shape of the `config` document and the defaults used before onboarding is finished.

import type { CurrencyCode, RateTable } from '../core/money';
import type { AcademicConfig, BillingMode, Course, Intensity, TuitionConfig } from '../core/types';
import type { Locale } from '../i18n';
import { getRegionPreset, type RegionPreset } from '../data/regions';

export interface CalendarSource {
  id: string;
  /** File name the user imported (display only). */
  name: string;
}

/** Class reminders (browser notifications while the page is open). */
export interface ReminderConfig {
  enabled: boolean;
  /** Minutes before a class starts; 0 = no "about to start" reminder (the "class is over" one stays). */
  leadMinutes: number;
}

export const DEFAULT_REMINDERS: ReminderConfig = { enabled: false, leadMinutes: 5 };

/** "system" follows the operating system's light / dark setting; the other two force one of the themes. */
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const DEFAULT_THEME: ThemeChoice = 'system';

export interface AppConfig {
  schemaVersion: number;
  /** True once the 7-step onboarding has been completed; until then the app shows the wizard. */
  onboardingDone?: boolean;
  school?: string;
  region?: RegionPreset['id'];
  currency?: CurrencyCode;
  academic?: AcademicConfig;
  billingMode?: BillingMode;
  /** Tuition in integer minor units (cents). `byPool` exists only when billing per semester. */
  tuition?: TuitionConfig;
  courses?: Course[];
  calendars?: CalendarSource[];
  reminders?: ReminderConfig;
  /** Interface language (default zh-CN). */
  language?: Locale;
  /** Tone of the copy lines: gentle / normal / extreme (default normal). */
  intensity?: Intensity;
  /** Light / dark theme choice (default: follow the system). */
  theme?: ThemeChoice;
  /**
   * A second currency shown as small text under the big numbers ("≈ ¥2,450"). Absent / null = off. The exchange rates
   * are the built-in table plus the user's overrides in `rates` (never fetched from the network).
   */
  secondaryCurrency?: CurrencyCode | null;
  /** The user's overrides of the built-in rate table: USD value of one major unit of the currency (core's RateTable). */
  rates?: RateTable;
}

export const DEFAULT_CURRENCY: CurrencyCode = 'HKD';

export function defaultAcademic(): AcademicConfig {
  const preset = getRegionPreset('northern');
  return { yearStart: preset.yearStart, splitDate: preset.splitDate, billingPeriod: 'semester' };
}

export function emptyConfig(): AppConfig {
  return { schemaVersion: 1 };
}

export function isOnboarded(config: AppConfig): boolean {
  return config.onboardingDone === true;
}
