// Shared set-up for the dashboard / slacking tests: the fictional full-term calendar, an onboarded config built the
// way the wizard builds it, and the six instants used throughout (Asia/Hong_Kong; Vitest pins TZ to it).

import fs from 'node:fs';
import path from 'node:path';
import { buildPools, type Pool } from '../../src/core/billing';
import { groupSessions } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';
import type { Session } from '../../src/core/types';
import type { AppConfig } from '../../src/state/config';
import type { DashboardInputs } from '../../src/state/dashboard';
import { billableOf, billingConfigOf } from '../../src/state/derived';
import { buildConfig, initialDraft } from '../../src/state/onboarding';

export const fullTermText = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'full-term.ics'), 'utf8');

export const hk = (iso: string): number => Date.parse(`${iso}+08:00`);

/** 2026-11-12 is a Thursday: MFIN7002 10:00-13:00 (HK). */
export const NOWS = {
  beforeTerm: hk('2026-08-20T10:00:00'),
  inClass: hk('2026-11-12T10:30:00'),
  break: hk('2026-11-12T08:00:00'),
  doneToday: hk('2026-11-12T14:00:00'),
  noClassToday: hk('2026-11-13T10:00:00'),
  afterTerm: hk('2027-05-10T10:00:00'),
} as const;

export const CLASS_ID = 'ft-thu-s1@fixture|2026-11-12T02:00:00Z';
export const CLASS_START = hk('2026-11-12T10:00:00');
export const CLASS_END = hk('2026-11-12T13:00:00');

export function fixtureConfig(tuitionText = '398000', billingPeriod: 'semester' | 'year' = 'semester'): AppConfig {
  const sessions = expandIcs(fullTermText);
  const config = buildConfig({ ...initialDraft(), tuitionText, billingPeriod }, groupSessions(sessions), [{ id: 'cal-fixture', name: 'full-term.ics' }]);
  if (!config) throw new Error('fixture config could not be built');
  return config;
}

/** Dashboard inputs for a config and calendar texts, computed with core only (no signals). */
export function inputsFor(config: AppConfig, texts: string[], extra: Partial<DashboardInputs> = {}): DashboardInputs {
  const sessions = texts.flatMap((t) => expandIcs(t));
  const courses = config.courses ?? [];
  const billable = billableOf(sessions as Session[], courses);
  const pools: Pool[] = billable.length ? buildPools(billable, billingConfigOf(config)) : [];
  return { sessions: billable, courses, pools, marks: {}, slacks: [], currency: config.currency ?? 'HKD', ...extra };
}

// ------------------------------------------------------------------ two academic years (P4b)

/** A second academic year (2027): the same two courses plus a new one (MFIN7003), one semester (2027-S1). */
export const nextYearText = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'next-year.ics'), 'utf8');

/** 2027-10-11 is a Monday: MFIN7001 09:00-12:00 (HK) in the 2027 academic year. */
export const NOWS_Y2 = {
  inClass: hk('2027-10-11T10:30:00'),
  beforeTerm: hk('2027-08-20T10:00:00'),
  afterTerm: hk('2028-05-10T10:00:00'),
} as const;

export const NEXT_CLASS_ID = 'nx-mon-s1@fixture|2027-10-11T01:00:00Z';

/** The config the wizard would build if both calendars had been imported at the start (three courses, 398,000 per semester). */
export function twoYearConfig(tuitionText = '398000'): AppConfig {
  const sessions = [...expandIcs(fullTermText), ...expandIcs(nextYearText)];
  const config = buildConfig({ ...initialDraft(), tuitionText }, groupSessions(sessions), [
    { id: 'cal-fixture', name: 'full-term.ics' },
    { id: 'cal-1', name: 'next-year.ics' },
  ]);
  if (!config) throw new Error('two-year config could not be built');
  return config;
}
