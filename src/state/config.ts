// Shape of the `config` document and the defaults used before onboarding is finished.

import type { CurrencyCode } from '../core/money';
import type { AcademicConfig, BillingMode, Course, TuitionConfig } from '../core/types';
import { getRegionPreset, type RegionPreset } from '../data/regions';

export interface CalendarSource {
  id: string;
  /** File name the user imported (display only). */
  name: string;
}

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
