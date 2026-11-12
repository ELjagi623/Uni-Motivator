// Course identification: group calendar sessions into candidate courses, suggest which ones are real classes,
// and re-attach sessions to confirmed courses after a re-import.

import type { Course, Session } from './types';

const CODE_RE = /\b[A-Z]{2,5}\s?\d{3,5}[A-Z]?\b/;
const EXCLUDE_RE = /\b(?:exams?|examination|quiz(?:zes)?|deadline|due|holiday|reading week|office hours?)\b|考试|假期|放假|补考/i;
const SUFFIX_RE = /[\s\-–:·,/]*\b(?:lecture|tutorial|lab|laboratory|seminar|workshop|class|practical|studio)s?\b[\s\-–:·,/]*$|[\s\-–:·,/]*(?:讲座|讲课|习题课|实验课|实验|研讨课|辅导课)[\s\-–:·,/]*$/i;

export const MIN_SESSIONS_FOR_COURSE = 4;
export const MIN_SESSION_SECONDS = 45 * 60;
export const MAX_SESSION_SECONDS = 4 * 3600;

/** Palette for course colours (data, not theme: the UI may tint them). */
export const COURSE_COLORS = ['#3b6ea8', '#c8763a', '#4f9d69', '#8a5fb5', '#c25a6e', '#3d9aa6', '#a8923b', '#6f7f93'] as const;

export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/** First course code in the title, upper-cased and without inner space ("COMP 3230" -> "COMP3230"), or null. */
export function extractCourseCode(title: string): string | null {
  const m = CODE_RE.exec(title);
  return m ? m[0].replace(/\s+/g, '').toUpperCase() : null;
}

export function isExcludedTitle(title: string): boolean {
  return EXCLUDE_RE.test(title);
}

export type GroupReason = 'ok' | 'too-few' | 'bad-duration' | 'excluded-keyword';

export interface CourseGroup {
  key: string;
  code: string | null;
  /** Suggested display name. */
  name: string;
  titles: string[];
  sessionIds: string[];
  count: number;
  totalSeconds: number;
  suggested: boolean;
  reason: GroupReason;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function displayName(titles: string[], counts: Map<string, number>, code: string | null): string {
  const best = titles.slice().sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))[0];
  if (!best) return code ?? '';
  const stripped = best.replace(SUFFIX_RE, '').trim();
  if (stripped && stripped !== code) return stripped;
  return stripped || code || best;
}

/** Group sessions by course code (same code => same course, e.g. Lecture + Tutorial) or by normalised title. */
export function groupSessions(sessions: readonly Session[]): CourseGroup[] {
  interface Acc {
    code: string | null;
    excluded: boolean;
    titleCounts: Map<string, number>;
    ids: string[];
    durations: number[];
  }
  const groups = new Map<string, Acc>();
  for (const s of sessions) {
    const title = normalizeTitle(s.title);
    const excluded = isExcludedTitle(title);
    const code = extractCourseCode(title);
    // Exams, holidays etc. never merge into the course they mention.
    const key = excluded ? `x:${title.toLowerCase()}` : code ? `code:${code}` : `title:${title.toLowerCase()}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = { code: excluded ? null : code, excluded, titleCounts: new Map(), ids: [], durations: [] };
      groups.set(key, acc);
    }
    acc.titleCounts.set(title, (acc.titleCounts.get(title) ?? 0) + 1);
    acc.ids.push(s.id);
    acc.durations.push((s.endMs - s.startMs) / 1000);
  }

  const result: CourseGroup[] = [];
  for (const [key, acc] of groups) {
    const titles = [...acc.titleCounts.keys()].sort();
    const count = acc.ids.length;
    const totalSeconds = Math.round(acc.durations.reduce((a, b) => a + b, 0));
    const med = median(acc.durations);
    let reason: GroupReason = 'ok';
    if (acc.excluded) reason = 'excluded-keyword';
    else if (count < MIN_SESSIONS_FOR_COURSE) reason = 'too-few';
    else if (med < MIN_SESSION_SECONDS || med > MAX_SESSION_SECONDS) reason = 'bad-duration';
    result.push({
      key,
      code: acc.code,
      name: displayName(titles, acc.titleCounts, acc.code),
      titles,
      sessionIds: acc.ids,
      count,
      totalSeconds,
      suggested: reason === 'ok',
      reason,
    });
  }
  return result.sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.totalSeconds - a.totalSeconds || (a.key < b.key ? -1 : 1));
}

export interface CourseOptions {
  credits?: number | null;
  /** Index into COURSE_COLORS (wraps around). */
  colorIndex?: number;
}

/** Turn a confirmed group into a Course. The id is derived from the group key, so it is stable across re-imports. */
export function courseFromGroup(group: CourseGroup, options: CourseOptions = {}): Course {
  const idx = options.colorIndex ?? 0;
  return {
    id: `c-${hash(group.key)}`,
    code: group.code,
    name: group.name,
    credits: options.credits ?? null,
    color: COURSE_COLORS[((idx % COURSE_COLORS.length) + COURSE_COLORS.length) % COURSE_COLORS.length],
    match: group.code
      ? { codes: [group.code], titles: [] }
      : { codes: [], titles: group.titles.map((t) => t.toLowerCase()) },
  };
}

/** Which confirmed course (if any) does a session title belong to? */
export function matchCourse(title: string, courses: readonly Course[]): Course | null {
  const norm = normalizeTitle(title).toLowerCase();
  for (const c of courses) if (c.match.titles.includes(norm)) return c;
  if (isExcludedTitle(title)) return null;
  const code = extractCourseCode(title);
  if (code) for (const c of courses) if (c.match.codes.includes(code)) return c;
  return null;
}

/** sessionId -> courseId for every session that belongs to one of the courses. */
export function assignCourses(sessions: readonly Session[], courses: readonly Course[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sessions) {
    const c = matchCourse(s.title, courses);
    if (c) out.set(s.id, c.id);
  }
  return out;
}

/** The sessions that belong to the confirmed courses, in the original order. */
export function sessionsOfCourses(sessions: readonly Session[], courses: readonly Course[]): Session[] {
  const assigned = assignCourses(sessions, courses);
  return sessions.filter((s) => assigned.has(s.id));
}
