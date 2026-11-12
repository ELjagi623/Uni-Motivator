// Writing user marks (停课 / 翘课). The `marks` document is `{schemaVersion, marks: {<session id>: SessionMark}}`
// (the shape P3b already reads through `marksOf`). The key is the session id, `UID|original start UTC`, so marks
// survive a re-import of the calendar. Marking never changes any price: billing ignores marks; only the summaries
// and the status machine (a cancelled class is not "in class") look at them.

import type { MarkStatus, SessionMark } from '../core/types';
import { setDoc, marks as marksDoc } from './data';
import { marksOf } from './dashboard';
import { demoActive } from './demoState';
import { billableSessions } from './derived';
import { isSessionReadOnly } from './years';

/** A mark with nothing left in it is removed from the document. */
function isEmptyMark(mark: SessionMark): boolean {
  return mark.status === undefined && !mark.lateMin && !mark.earlyMin;
}

/**
 * Set (`status`) or clear (`null`) the mark of one session. Other fields of the mark (late / early minutes, added in a
 * later phase) are kept. The change is saved with the usual debounced PUT of `marks`.
 *
 * Sessions of an archived academic year are read-only: the change is refused (returns false) and nothing is written.
 */
export function setMark(sessionId: string, status: MarkStatus | null): boolean {
  if (demoActive.peek()) return false; // the demo never writes anything
  if (isSessionReadOnly(sessionId)) return false;
  const doc = marksDoc.peek();
  const current = marksOf(doc);
  const mark: SessionMark = { ...(current[sessionId] ?? {}) };
  if (status === null) delete mark.status;
  else mark.status = status;
  const next = { ...current };
  if (isEmptyMark(mark)) delete next[sessionId];
  else next[sessionId] = mark;
  setDoc('marks', { ...doc, marks: next });
  return true;
}

/** Toggle: marking a session with the status it already has clears the mark. */
export function toggleMark(sessionId: string, status: MarkStatus): boolean {
  const current = marksOf(marksDoc.peek())[sessionId]?.status ?? null;
  return setMark(sessionId, current === status ? null : status);
}

// ------------------------------------------------------------------ late arrival / early leaving

export type LateKind = 'late' | 'early';
export type LateEarlyResult = 'ok' | 'invalid' | 'readonly' | 'not-attended' | 'unknown';

/** Minutes typed by the user: '' -> 0 (cleared), a whole number >= 0 -> that number, anything else -> null. */
export function parseMinutesText(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d{1,4}$/.test(t)) return null;
  return Number(t);
}

/**
 * Record how many minutes the user arrived late / left early in one class. Each value must be between 0 and the class's
 * length in minutes, and together they cannot exceed it; classes marked as skipped or cancelled have no late / early
 * time. A value of 0 removes the field. Nothing is written when the input is refused. The loss (minutes x unit price)
 * is derived by core's `summarizeMarks`; marking never changes a unit price.
 */
export function setLateEarly(sessionId: string, kind: LateKind, text: string): LateEarlyResult {
  if (demoActive.peek()) return 'readonly';
  if (isSessionReadOnly(sessionId)) return 'readonly';
  const session = billableSessions.peek().find((s) => s.id === sessionId);
  if (!session) return 'unknown';
  const minutes = parseMinutesText(text);
  if (minutes === null) return 'invalid';
  const doc = marksDoc.peek();
  const current = marksOf(doc);
  const mark: SessionMark = { ...(current[sessionId] ?? {}) };
  if (mark.status !== undefined) return 'not-attended';
  const length = Math.floor((session.endMs - session.startMs) / 60_000);
  const other = (kind === 'late' ? mark.earlyMin : mark.lateMin) ?? 0;
  if (minutes > length || minutes + other > length) return 'invalid';
  const field = kind === 'late' ? 'lateMin' : 'earlyMin';
  if (minutes === 0) delete mark[field];
  else mark[field] = minutes;
  const next = { ...current };
  if (isEmptyMark(mark)) delete next[sessionId];
  else next[sessionId] = mark;
  setDoc('marks', { ...doc, marks: next });
  return 'ok';
}
