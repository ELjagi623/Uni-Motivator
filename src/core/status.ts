// The class-status state machine. Pure: pass any `now` and get the status for that instant.

import type { MarkMap } from './types';

export type StatusKind = 'before-term' | 'in-class' | 'break' | 'done-today' | 'no-class-today' | 'after-term';

export interface TimeSpan {
  id: string;
  startMs: number;
  endMs: number;
}

export interface Status<T extends TimeSpan> {
  kind: StatusKind;
  /** The session in progress (only for 'in-class'). */
  current?: T;
  /** Other sessions in progress at the same time (overlaps); the UI offers a switch button when non-empty. */
  alsoActive: T[];
  /** First not-yet-started session after `now`. */
  next?: T;
  /** Most recently finished session. */
  prev?: T;
  /** All sessions that start today (local calendar day), cancelled ones included, in time order. */
  today: T[];
}

function compareSpans(a: TimeSpan, b: TimeSpan): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Decide what is going on at `nowMs`.
 *
 * - Cancelled sessions (停课) never make the status "in class" or count as "later today"; they still appear in `today`.
 * - Overlapping sessions: the one not marked as skipped (翘课) wins; otherwise the one that started first.
 * - On the day of the very first class (before it starts) the status is 'break' and on the day of the very last class
 *   (after it ended) it is 'done-today'; 'before-term' / 'after-term' apply from the neighbouring days on.
 */
export function getStatus<T extends TimeSpan>(nowMs: number, sessions: readonly T[], marks: MarkMap = {}): Status<T> {
  const sorted = sessions.slice().sort(compareSpans);
  const now = new Date(nowMs);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();

  const today = sorted.filter((s) => s.startMs >= dayStart && s.startMs < dayEnd);
  const effective = sorted.filter((s) => marks[s.id]?.status !== 'cancelled');

  let prev: T | undefined;
  let next: T | undefined;
  for (const s of effective) {
    if (s.endMs <= nowMs && (!prev || s.endMs >= prev.endMs)) prev = s;
    if (!next && s.startMs > nowMs) next = s;
  }

  const active = effective.filter((s) => s.startMs <= nowMs && nowMs < s.endMs);
  if (active.length > 0) {
    const ordered = [...active.filter((s) => marks[s.id]?.status !== 'skipped'), ...active.filter((s) => marks[s.id]?.status === 'skipped')];
    return { kind: 'in-class', current: ordered[0], alsoActive: ordered.slice(1), next, prev, today };
  }

  const todayEffective = effective.filter((s) => s.startMs >= dayStart && s.startMs < dayEnd);
  const base = { alsoActive: [] as T[], next, prev, today };
  if (todayEffective.length > 0) {
    return { kind: todayEffective.some((s) => s.startMs > nowMs) ? 'break' : 'done-today', ...base };
  }
  if (effective.length === 0 || nowMs < effective[0].startMs) return { kind: 'before-term', ...base };
  const lastEnd = Math.max(...effective.map((s) => s.endMs));
  if (nowMs >= lastEnd) return { kind: 'after-term', ...base };
  return { kind: 'no-class-today', ...base };
}
