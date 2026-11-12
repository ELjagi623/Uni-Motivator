// Slacking ("摸鱼"): the amount is always derived as unit price x seconds that overlap the session. It is never stored.

import type { SlackRecord } from './types';

export interface SlackSession {
  id: string;
  startMs: number;
  endMs: number;
}

/** The part of a slack record that lies inside its session, or null when there is none. */
export function slackInterval(record: SlackRecord, session: SlackSession, nowMs: number): { fromMs: number; toMs: number } | null {
  const fromMs = Math.max(record.startMs, session.startMs);
  // A running record (no endMs) lasts until `now`; nothing beyond the end of the class is billed.
  const toMs = Math.min(record.endMs ?? nowMs, session.endMs);
  return toMs > fromMs ? { fromMs, toMs } : null;
}

/** Seconds of this slack record that overlap its session. */
export function slackSeconds(record: SlackRecord, session: SlackSession, nowMs: number): number {
  const iv = slackInterval(record, session, nowMs);
  return iv ? (iv.toMs - iv.fromMs) / 1000 : 0;
}

/** Amount (integer minor units) = unit price (minor per second) x overlapping seconds. */
export function slackAmountMinor(record: SlackRecord, session: SlackSession, ratePerSec: number, nowMs: number): number {
  return Math.round(ratePerSec * slackSeconds(record, session, nowMs));
}

/** A record is running while it has no end and its class has not finished. */
export function isSlackRunning(record: SlackRecord, session: SlackSession | undefined, nowMs: number): boolean {
  if (record.endMs !== undefined) return false;
  return !session || nowMs < session.endMs;
}

/**
 * Auto-truncate: a record without `endMs` whose class is over (also when the page was closed meanwhile) gets
 * `endMs = class end`. Returns the new list and the records that changed; the input is not modified.
 */
export function closeFinishedSlacks(
  records: readonly SlackRecord[],
  sessionsById: ReadonlyMap<string, SlackSession>,
  nowMs: number,
): { records: SlackRecord[]; changed: SlackRecord[] } {
  const changed: SlackRecord[] = [];
  const out = records.map((r) => {
    if (r.endMs !== undefined) return r;
    const session = sessionsById.get(r.sessionId);
    if (!session || nowMs < session.endMs) return r;
    const closed: SlackRecord = { ...r, endMs: Math.max(session.endMs, r.startMs) };
    changed.push(closed);
    return closed;
  });
  return { records: out, changed };
}

/** Total slack seconds per session id at `now`. */
export function slackSecondsBySession(
  records: readonly SlackRecord[],
  sessionsById: ReadonlyMap<string, SlackSession>,
  nowMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    const s = sessionsById.get(r.sessionId);
    if (!s) continue;
    out.set(r.sessionId, (out.get(r.sessionId) ?? 0) + slackSeconds(r, s, nowMs));
  }
  return out;
}
