// Shared types for the pure core. All times are UTC milliseconds; all money is integer minor units (cents)
// unless a field name says otherwise. Nothing in core reads the clock: `now` is always a parameter.

/** One concrete class meeting, expanded from a calendar (or created manually in a later phase). */
export interface Session {
  /** `<UID>|<original start UTC ISO, second precision>`; manual sessions use `manual:<courseId>|<start>`. */
  id: string;
  uid: string;
  title: string;
  location: string;
  startMs: number;
  endMs: number;
  /** Where the session came from; absent = a calendar. */
  source?: 'calendar' | 'manual';
  /** Manual sessions name their course directly (calendar sessions are matched to courses by title / code). */
  courseId?: string;
}

/** A user-confirmed course. Re-importing a calendar re-attaches sessions through `match`. */
export interface Course {
  id: string;
  /** Normalised course code (e.g. "COMP3230"), or null for title-only courses. */
  code: string | null;
  name: string;
  /** Credits, used only by the credit-weighted billing mode. */
  credits: number | null;
  color: string;
  match: { codes: string[]; titles: string[] };
  /** True for a course the user created by hand (no calendar event matches it). */
  manual?: boolean;
}

/** `MM-DD` strings; see academic.ts. */
export interface AcademicConfig {
  yearStart: string;
  splitDate: string;
  billingPeriod: 'semester' | 'year';
}

export type MarkStatus = 'cancelled' | 'skipped';

/** User mark on one session (keyed by session id in the marks document). */
export interface SessionMark {
  /** cancelled = class cancelled by the school (停课); skipped = the user chose not to go (翘课). */
  status?: MarkStatus;
  /** Minutes arrived late / left early (only meaningful when status is not set). */
  lateMin?: number;
  earlyMin?: number;
}

export type MarkMap = Record<string, SessionMark>;

/** A slack-off record as stored in slacks.json. `endMs` is absent while the slacking is still running. */
export interface SlackRecord {
  id: string;
  sessionId: string;
  startMs: number;
  endMs?: number;
}

export type BillingMode = 'duration' | 'credit';

/** Tuition per pool. `defaultMinor` applies to every pool without an entry in `byPool`; null = not set. */
export interface TuitionConfig {
  defaultMinor: number | null;
  /** Pool key (see academic.poolKey) -> tuition in minor units, or null for "not set". */
  byPool?: Record<string, number | null>;
}

export type Intensity = 'gentle' | 'normal' | 'extreme';
export type CopyScene = 'in-class' | 'slacking' | 'break' | 'settlement';
