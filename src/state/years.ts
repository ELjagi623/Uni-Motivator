// Academic years in the app state: which years the timetable covers, which one is current and which are archived
// (read-only). The rules are core's (`src/core/years.ts`); this file binds them to the data and formats them.

import { computed } from '@preact/signals';
import { academicYearsOf, focusYearOf, isSessionArchived, sessionsOfYear, type YearInfo, type YearRole } from '../core/years';
import { formatMinor } from '../core/money';
import type { AcademicConfig } from '../core/types';
import { t } from '../i18n';
import { defaultAcademic } from './config';
import { billableSessions, currency, pools } from './derived';
import { activeNow, hourBucket } from './now';
import { activeConfig } from './source';

export const academicConfig = computed<AcademicConfig>(() => activeConfig.value.academic ?? defaultAcademic());

/** The academic years that have classes. Roles are re-evaluated once an hour. */
export const yearInfos = computed<YearInfo[]>(() => {
  void hourBucket.value;
  return academicYearsOf(billableSessions.value, academicConfig.value, activeNow.peek());
});

/** The year the main screen shows: the current one, else the nearest upcoming one, else the latest archive. */
export const focusYear = computed<number | null>(() => focusYearOf(yearInfos.value));

export function yearLabel(year: number): string {
  return t('years.label', { year });
}

export function roleLabel(role: YearRole): string {
  return t(role === 'current' ? 'years.role.current' : role === 'archived' ? 'years.role.archived' : 'years.role.upcoming');
}

export interface YearView {
  year: number;
  label: string;
  role: YearRole;
  roleLabel: string;
  sessionCount: number;
  hoursText: string;
  /** Total tuition of the year's pools that have one, as money text; "" when none is set. */
  tuitionText: string;
  /** True when at least one of the year's tuition pools has no tuition yet. */
  hasUnset: boolean;
  readOnly: boolean;
}

/** The year list shown in the settings: one row per year. */
export const yearViews = computed<YearView[]>(() =>
  yearInfos.value.map((y) => {
    const own = pools.value.filter((p) => p.year === y.year);
    const set = own.filter((p) => p.tuitionMinor !== null);
    const tuition = set.reduce((sum, p) => sum + (p.tuitionMinor ?? 0), 0);
    return {
      year: y.year,
      label: yearLabel(y.year),
      role: y.role,
      roleLabel: roleLabel(y.role),
      sessionCount: y.sessionCount,
      hoursText: (y.totalSeconds / 3600).toFixed(1),
      tuitionText: set.length > 0 ? formatMinor(tuition, currency.value) : '',
      hasUnset: set.length < own.length,
      readOnly: y.role === 'archived',
    };
  }),
);

/** True when the session belongs to an archived academic year (read-only). Unknown sessions are not archived. */
export function isSessionReadOnly(sessionId: string, nowMs: number = activeNow.peek()): boolean {
  const s = billableSessions.peek().find((x) => x.id === sessionId);
  return s ? isSessionArchived(s.startMs, nowMs, academicConfig.peek()) : false;
}

/** The sessions (of the billable ones) in the given academic year. */
export function billableSessionsOfYear(year: number) {
  return sessionsOfYear(billableSessions.peek(), year, academicConfig.peek());
}
