// Writing user marks (停课 / 翘课). The `marks` document is `{schemaVersion, marks: {<session id>: SessionMark}}`
// (the shape P3b already reads through `marksOf`). The key is the session id, `UID|original start UTC`, so marks
// survive a re-import of the calendar. Marking never changes any price: billing ignores marks; only the summaries
// and the status machine (a cancelled class is not "in class") look at them.

import type { MarkStatus, SessionMark } from '../core/types';
import { setDoc, marks as marksDoc } from './data';
import { marksOf } from './dashboard';
import { demoActive } from './demoState';
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
