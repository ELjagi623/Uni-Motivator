// Billing: tuition pools, unit price, and "how much has been consumed at time `now`".
//
// Everything is derived from the timetable and `now` on every call (never accumulated by ticking), so a laptop
// that slept for a week shows the right number the moment it wakes up.
//
// Money rules (see CLAUDE.md): tuition is an integer number of minor units. Internally the unit price is a
// float (minor units per second); every amount handed out is an integer and `consumed + remaining === tuition`
// holds exactly, for every `now`.

import { groupByPool, parseMonthDay, termOf } from './academic';
import type { AcademicConfig, BillingMode, MarkMap, TuitionConfig } from './types';

export interface BillableSession {
  id: string;
  startMs: number;
  endMs: number;
  courseId?: string | null;
}

export interface BillingConfig {
  academic: AcademicConfig;
  /** Default 'duration'. */
  mode?: BillingMode;
  tuition: TuitionConfig;
  /** courseId -> credits; only used in 'credit' mode. A missing / non-positive value counts as 1. */
  credits?: Record<string, number | null | undefined>;
}

export interface PoolSession {
  id: string;
  startMs: number;
  endMs: number;
  durationSec: number;
  courseId: string | null;
  /** Unit price of this session in minor units per second (float). */
  ratePerSec: number;
  /** Exact cost (float, minor units). */
  costExact: number;
  /** Integer cost; the integer costs of a pool add up to exactly the pool's tuition. */
  costMinor: number;
}

export interface Pool {
  key: string;
  year: number;
  /** null when billing per academic year. */
  semester: 1 | 2 | null;
  /** null = the user has not set a tuition for this pool yet. */
  tuitionMinor: number | null;
  sessions: PoolSession[]; // sorted by start
  totalSeconds: number;
  firstStartMs: number;
  lastEndMs: number;
  /** Average unit price (minor per second) = tuition / total seconds; 0 when the tuition is unset. */
  averageRatePerSec: number;
  // lookup structures
  indexById: Map<string, number>;
  byEnd: number[]; // session indexes ordered by end time
  endTimes: number[];
  endCostPrefix: number[]; // cumulative exact cost in byEnd order
  endSecPrefix: number[]; // cumulative seconds in byEnd order
  maxDurationMs: number;
}

export interface PoolState {
  poolKey: string;
  /** False when the tuition is not set: the money fields are then all 0. */
  tuitionSet: boolean;
  tuitionMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  /** Fraction of the pool's class time that has passed, 0..1 (exactly 1 after the last session ends). */
  progress: number;
  averageRatePerSec: number;
}

function poolTuition(cfg: BillingConfig, key: string): number | null {
  const own = cfg.tuition.byPool && Object.prototype.hasOwnProperty.call(cfg.tuition.byPool, key) ? cfg.tuition.byPool[key] : undefined;
  const value = own === undefined ? cfg.tuition.defaultMinor : own;
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`Tuition must be a non-negative integer number of minor units (pool ${key}).`);
  return value;
}

function lowerBound(sorted: number[], x: number, strictlyLess: boolean): number {
  // number of elements e with e <= x (strictlyLess=false) or e < x (strictlyLess=true)
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (strictlyLess ? sorted[mid] < x : sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildPool(key: string, list: BillableSession[], cfg: BillingConfig): Pool {
  const first = list[0];
  const term = termOf(first.startMs, cfg.academic);
  const tuition = poolTuition(cfg, key);
  const mode: BillingMode = cfg.mode ?? 'duration';

  const durations = list.map((s) => (s.endMs - s.startMs) / 1000);
  const totalSeconds = durations.reduce((a, b) => a + b, 0);

  // Unit price per session.
  const rates: number[] = new Array(list.length).fill(0);
  if (tuition !== null && tuition > 0) {
    if (mode === 'credit') {
      const weightOf = (courseId: string | null): number => {
        const c = courseId ? cfg.credits?.[courseId] : undefined;
        return typeof c === 'number' && c > 0 ? c : 1;
      };
      const seconds = new Map<string, number>();
      list.forEach((s, i) => {
        const k = s.courseId ?? '';
        seconds.set(k, (seconds.get(k) ?? 0) + durations[i]);
      });
      let weightSum = 0;
      for (const k of seconds.keys()) weightSum += weightOf(k === '' ? null : k);
      list.forEach((s, i) => {
        const k = s.courseId ?? '';
        const share = (tuition * weightOf(k === '' ? null : k)) / weightSum;
        rates[i] = share / (seconds.get(k) as number);
      });
    } else {
      rates.fill(tuition / totalSeconds);
    }
  }

  const exact = list.map((_, i) => rates[i] * durations[i]);
  // Integer allocation by cumulative rounding: the per-session integers sum to exactly the tuition.
  const costMinor: number[] = [];
  let cum = 0;
  let prevRounded = 0;
  list.forEach((_, i) => {
    cum += exact[i];
    const rounded = i === list.length - 1 && tuition !== null ? tuition : Math.round(cum);
    costMinor.push(rounded - prevRounded);
    prevRounded = rounded;
  });

  const sessions: PoolSession[] = list.map((s, i) => ({
    id: s.id,
    startMs: s.startMs,
    endMs: s.endMs,
    durationSec: durations[i],
    courseId: s.courseId ?? null,
    ratePerSec: rates[i],
    costExact: exact[i],
    costMinor: tuition === null ? 0 : costMinor[i],
  }));

  const byEnd = sessions.map((_, i) => i).sort((a, b) => sessions[a].endMs - sessions[b].endMs || a - b);
  const endTimes = byEnd.map((i) => sessions[i].endMs);
  const endCostPrefix: number[] = [];
  const endSecPrefix: number[] = [];
  let c = 0;
  let sec = 0;
  for (const i of byEnd) {
    c += sessions[i].costExact;
    sec += sessions[i].durationSec;
    endCostPrefix.push(c);
    endSecPrefix.push(sec);
  }

  return {
    key,
    year: term.year,
    semester: cfg.academic.billingPeriod === 'year' ? null : term.semester,
    tuitionMinor: tuition,
    sessions,
    totalSeconds,
    firstStartMs: Math.min(...sessions.map((s) => s.startMs)),
    lastEndMs: endTimes[endTimes.length - 1],
    averageRatePerSec: tuition === null ? 0 : tuition / totalSeconds,
    indexById: new Map(sessions.map((s, i) => [s.id, i])),
    byEnd,
    endTimes,
    endCostPrefix,
    endSecPrefix,
    maxDurationMs: Math.max(...sessions.map((s) => s.endMs - s.startMs)),
  };
}

/** Build the tuition pools for a set of sessions (only sessions with a positive duration are considered). */
export function buildPools(sessions: readonly BillableSession[], cfg: BillingConfig): Pool[] {
  parseMonthDay(cfg.academic.yearStart); // fail early on malformed configuration
  parseMonthDay(cfg.academic.splitDate);
  const valid = sessions.filter((s) => s.endMs > s.startMs);
  const grouped = groupByPool(valid, cfg.academic);
  const byId = new Map(valid.map((s) => [s.id, s]));
  const pools: Pool[] = [];
  for (const [key, list] of grouped) {
    pools.push(buildPool(key, list.map((s) => byId.get(s.id) as BillableSession), cfg));
  }
  return pools.sort((a, b) => a.firstStartMs - b.firstStartMs);
}

/** Exact (float) amounts at `now`: [consumed minor, elapsed seconds]. */
function accumulate(pool: Pool, nowMs: number): { consumed: number; seconds: number } {
  if (nowMs <= pool.firstStartMs) return { consumed: 0, seconds: 0 };
  if (nowMs >= pool.lastEndMs) return { consumed: pool.tuitionMinor ?? 0, seconds: pool.totalSeconds };

  // Finished sessions: prefix sums over the sessions ordered by end time.
  const done = lowerBound(pool.endTimes, nowMs, false);
  let consumed = done > 0 ? pool.endCostPrefix[done - 1] : 0;
  let seconds = done > 0 ? pool.endSecPrefix[done - 1] : 0;

  // Sessions in progress (start < now < end). Sessions are sorted by start, and no session is longer than maxDurationMs.
  const startTimes = pool.sessions; // sorted by start
  let hi = 0;
  {
    let lo = 0;
    let top = startTimes.length;
    while (lo < top) {
      const mid = (lo + top) >>> 1;
      if (startTimes[mid].startMs < nowMs) lo = mid + 1;
      else top = mid;
    }
    hi = lo; // sessions [0, hi) started before now
  }
  for (let i = hi - 1; i >= 0; i--) {
    const s = startTimes[i];
    if (s.startMs <= nowMs - pool.maxDurationMs) break;
    if (s.endMs > nowMs) {
      const elapsed = (nowMs - s.startMs) / 1000;
      consumed += s.ratePerSec * elapsed;
      seconds += elapsed;
    }
  }
  return { consumed, seconds };
}

export function poolStateAt(pool: Pool, nowMs: number): PoolState {
  const tuitionSet = pool.tuitionMinor !== null;
  const tuition = pool.tuitionMinor ?? 0;
  const { consumed, seconds } = accumulate(pool, nowMs);
  let consumedMinor = 0;
  if (tuitionSet) {
    consumedMinor = nowMs >= pool.lastEndMs ? tuition : Math.min(tuition, Math.max(0, Math.round(consumed)));
  }
  const progress = nowMs >= pool.lastEndMs ? 1 : Math.min(1, Math.max(0, seconds / pool.totalSeconds));
  return {
    poolKey: pool.key,
    tuitionSet,
    tuitionMinor: tuition,
    consumedMinor,
    remainingMinor: tuition - consumedMinor,
    progress,
    averageRatePerSec: pool.averageRatePerSec,
  };
}

export interface BillingState {
  /** Sum over pools whose tuition is set. */
  tuitionMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  /** Time-weighted progress over all pools (0..1). */
  progress: number;
  /** Pools without a tuition. */
  unsetPoolKeys: string[];
}

/** Totals over all pools at `now`. `consumedMinor + remainingMinor === tuitionMinor` always. */
export function billingStateAt(pools: readonly Pool[], nowMs: number): BillingState {
  let tuition = 0;
  let consumed = 0;
  let seconds = 0;
  let totalSeconds = 0;
  const unset: string[] = [];
  for (const p of pools) {
    const st = poolStateAt(p, nowMs);
    if (st.tuitionSet) {
      tuition += st.tuitionMinor;
      consumed += st.consumedMinor;
    } else unset.push(p.key);
    seconds += st.progress * p.totalSeconds;
    totalSeconds += p.totalSeconds;
  }
  const finished = pools.length > 0 && pools.every((p) => nowMs >= p.lastEndMs);
  return {
    tuitionMinor: tuition,
    consumedMinor: consumed,
    remainingMinor: tuition - consumed,
    progress: finished ? 1 : totalSeconds > 0 ? Math.min(1, seconds / totalSeconds) : 0,
    unsetPoolKeys: unset,
  };
}

export function findPoolOfSession(pools: readonly Pool[], sessionId: string): Pool | null {
  for (const p of pools) if (p.indexById.has(sessionId)) return p;
  return null;
}

export function getPoolSession(pool: Pool, sessionId: string): PoolSession | null {
  const i = pool.indexById.get(sessionId);
  return i === undefined ? null : pool.sessions[i];
}

export interface SessionState {
  sessionId: string;
  /** Integer cost of the whole session. */
  costMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  /** 0..1 */
  progress: number;
  /** Unit price in minor units per second. */
  ratePerSec: number;
}

/** Cost / consumption of one session at `now` (0 before it starts, the full cost after it ended). */
export function sessionStateAt(pool: Pool, sessionId: string, nowMs: number): SessionState | null {
  const s = getPoolSession(pool, sessionId);
  if (!s) return null;
  const progress = nowMs >= s.endMs ? 1 : nowMs <= s.startMs ? 0 : (nowMs - s.startMs) / (s.endMs - s.startMs);
  const consumed = progress >= 1 ? s.costMinor : Math.round(s.costMinor * progress);
  return {
    sessionId,
    costMinor: s.costMinor,
    consumedMinor: consumed,
    remainingMinor: s.costMinor - consumed,
    progress,
    ratePerSec: s.ratePerSec,
  };
}

// ------------------------------------------------------------------------------------------ marks

export interface MarkSummary {
  /** Sessions counted (all of them, or only those that ended by `asOfMs`). */
  sessionCount: number;
  cancelledCount: number;
  skippedCount: number;
  attendedCount: number;
  /** attended / (counted - cancelled); null when nothing was supposed to be attended. */
  attendanceRate: number | null;
  /** Tuition swallowed by the school: cost of cancelled (停课) sessions. */
  cancelledMinor: number;
  /** Cost of sessions the user skipped (翘课). */
  skippedMinor: number;
  /** Cost of the minutes missed by arriving late / leaving early (minutes x unit price). */
  lateMinor: number;
  earlyMinor: number;
  lateMinutes: number;
  earlyMinutes: number;
  /** skipped + late + early (the money the user threw away; cancelled classes are the school's fault, not included). */
  lostMinor: number;
}

export interface MarkSummaryResult {
  total: MarkSummary;
  byPool: Record<string, MarkSummary>;
}

function emptySummary(): MarkSummary {
  return {
    sessionCount: 0,
    cancelledCount: 0,
    skippedCount: 0,
    attendedCount: 0,
    attendanceRate: null,
    cancelledMinor: 0,
    skippedMinor: 0,
    lateMinor: 0,
    earlyMinor: 0,
    lateMinutes: 0,
    earlyMinutes: 0,
    lostMinor: 0,
  };
}

/**
 * Summarise user marks. Cancelled and skipped sessions stay in the denominator of the unit price (marking never
 * changes the price). With `asOfMs` only sessions that have ended by then are counted.
 */
export function summarizeMarks(pools: readonly Pool[], marks: MarkMap, options: { asOfMs?: number } = {}): MarkSummaryResult {
  const byPool: Record<string, MarkSummary> = {};
  const total = emptySummary();

  for (const pool of pools) {
    const sum = emptySummary();
    let lateExactPool = 0;
    let earlyExactPool = 0;
    for (const s of pool.sessions) {
      if (options.asOfMs !== undefined && s.endMs > options.asOfMs) continue;
      sum.sessionCount++;
      const mark = marks[s.id];
      const status = mark?.status;
      if (status === 'cancelled') {
        sum.cancelledCount++;
        sum.cancelledMinor += s.costMinor;
        continue;
      }
      if (status === 'skipped') {
        sum.skippedCount++;
        sum.skippedMinor += s.costMinor;
        continue;
      }
      sum.attendedCount++;
      const durationMin = s.durationSec / 60;
      const late = Math.min(Math.max(mark?.lateMin ?? 0, 0), durationMin);
      const early = Math.min(Math.max(mark?.earlyMin ?? 0, 0), Math.max(durationMin - late, 0));
      sum.lateMinutes += late;
      sum.earlyMinutes += early;
      lateExactPool += late * 60 * s.ratePerSec;
      earlyExactPool += early * 60 * s.ratePerSec;
    }
    sum.lateMinor = Math.round(lateExactPool);
    sum.earlyMinor = Math.round(earlyExactPool);
    const counted = sum.sessionCount - sum.cancelledCount;
    sum.attendanceRate = counted > 0 ? sum.attendedCount / counted : null;
    sum.lostMinor = sum.skippedMinor + sum.lateMinor + sum.earlyMinor;
    byPool[pool.key] = sum;

    total.sessionCount += sum.sessionCount;
    total.cancelledCount += sum.cancelledCount;
    total.skippedCount += sum.skippedCount;
    total.attendedCount += sum.attendedCount;
    total.cancelledMinor += sum.cancelledMinor;
    total.skippedMinor += sum.skippedMinor;
    total.lateMinutes += sum.lateMinutes;
    total.earlyMinutes += sum.earlyMinutes;
    total.lateMinor += sum.lateMinor;
    total.earlyMinor += sum.earlyMinor;
  }
  const counted = total.sessionCount - total.cancelledCount;
  total.attendanceRate = counted > 0 ? total.attendedCount / counted : null;
  total.lostMinor = total.skippedMinor + total.lateMinor + total.earlyMinor;
  return { total, byPool };
}
