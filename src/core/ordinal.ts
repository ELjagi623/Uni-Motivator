// "Session 7 of 13": where a session stands among the sessions of its course.

export interface OrdinalSession {
  id: string;
  startMs: number;
  courseId?: string | null;
}

export interface Ordinal {
  /** 1-based position among the course's sessions, ordered by start time. */
  index: number;
  /** How many sessions the course has in the given list. */
  total: number;
}

/**
 * Position of `sessionId` among the sessions of its own course in `sessions` (pass one tuition pool's sessions to get
 * "session i of N this semester"). Cancelled and skipped sessions are counted too: they stay in the denominator
 * everywhere in the app. Returns null when the session is unknown or has no course.
 */
export function sessionOrdinal(sessions: readonly OrdinalSession[], sessionId: string): Ordinal | null {
  const target = sessions.find((s) => s.id === sessionId);
  if (!target || !target.courseId) return null;
  const same = sessions
    .filter((s) => s.courseId === target.courseId)
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = same.findIndex((s) => s.id === sessionId);
  return { index: index + 1, total: same.length };
}
