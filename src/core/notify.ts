// Class reminders: which notifications are due at an instant. Pure: the caller passes `nowMs` and remembers which
// reminders it has already shown (`firedKeys`), so the same reminder is never produced twice.
//
//  - "before": `leadMinutes` before a class starts, and still due until the class starts (a page opened a little late
//    still gets it). `leadMinutes <= 0` switches these off.
//  - "end": at the moment the class ends, due for `graceMs` afterwards (an "it is over" message is stale after that).
//  - Cancelled (停课) and skipped (翘课) classes never produce a reminder: the user is not going.

import { slackAmountMinor, slackSeconds } from './slack';
import type { MarkMap, SlackRecord } from './types';

export type ReminderKind = 'before' | 'end';

export const DEFAULT_LEAD_MINUTES = 5;
export const END_GRACE_MS = 2 * 60 * 1000;

export interface NotifySession {
  id: string;
  startMs: number;
  endMs: number;
}

export interface Reminder {
  /** `<kind>:<session id>`: remember it once shown. */
  key: string;
  kind: ReminderKind;
  sessionId: string;
  /** When the reminder became due (start - lead, or the end of the class). */
  dueMs: number;
}

export interface ReminderOptions {
  leadMinutes: number;
  graceMs?: number;
}

export function reminderKey(kind: ReminderKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}

/** The reminders that should be shown at `nowMs` and have not been shown yet, in due order. */
export function dueReminders(
  nowMs: number,
  sessions: readonly NotifySession[],
  marks: MarkMap,
  options: ReminderOptions,
  firedKeys: ReadonlySet<string> = new Set(),
): Reminder[] {
  const grace = options.graceMs ?? END_GRACE_MS;
  const lead = Number.isFinite(options.leadMinutes) ? options.leadMinutes * 60_000 : 0;
  const out: Reminder[] = [];
  for (const s of sessions) {
    const status = marks[s.id]?.status;
    if (status === 'cancelled' || status === 'skipped') continue;
    if (lead > 0) {
      const dueMs = s.startMs - lead;
      const key = reminderKey('before', s.id);
      if (nowMs >= dueMs && nowMs < s.startMs && !firedKeys.has(key)) out.push({ key, kind: 'before', sessionId: s.id, dueMs });
    }
    const endKey = reminderKey('end', s.id);
    if (nowMs >= s.endMs && nowMs < s.endMs + grace && !firedKeys.has(endKey)) out.push({ key: endKey, kind: 'end', sessionId: s.id, dueMs: s.endMs });
  }
  return out.sort((a, b) => a.dueMs - b.dueMs || (a.key < b.key ? -1 : 1));
}

export interface EndFigures {
  /** The whole session's cost. */
  costMinor: number;
  slackSeconds: number;
  /** Whole minutes slacked. */
  slackMinutes: number;
  /** Money wasted by slacking in this session (derived: unit price x overlapping seconds). */
  slackMinor: number;
}

/** The numbers in the "class is over" reminder: what the class cost and how much of it was slacked away. */
export function endFigures(session: NotifySession, costMinor: number, ratePerSec: number, slacks: readonly SlackRecord[], nowMs: number): EndFigures {
  let seconds = 0;
  let minor = 0;
  for (const r of slacks) {
    if (r.sessionId !== session.id) continue;
    seconds += slackSeconds(r, session, nowMs);
    minor += slackAmountMinor(r, session, ratePerSec, nowMs);
  }
  return { costMinor, slackSeconds: seconds, slackMinutes: Math.floor(seconds / 60), slackMinor: minor };
}
