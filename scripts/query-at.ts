// `npm run query -- --now <ISO-8601> [--data-dir <dir>] [--tz <zone>]`
//
// Prints (as JSON) what core computes for a data folder at a given instant: the status, the session in progress, the
// tuition pool ("tank"), next / previous session, today's slacking. It talks to core directly (not to the UI state
// layer), so it is a second, independent source for checking the numbers the page shows at `?now=<same instant>`.
//
//   --now        ISO-8601. Without a zone suffix it is local time of this computer (like ?now= in the browser).
//   --tz         IANA time zone to use for local-day notions (default: this computer's). The browser page uses the
//                browser's zone, so pass the same zone the browser reports when you compare day-based states.
//   --data-dir   a data folder (config.json, marks.json, slacks.json, calendars/*.ics). Default: $TT_DATA_DIR or ./data
//
// `marks` is core's summary of the user's marks (停课 / 翘课) over every pool for the sessions that had ended by `--now`;
// its `formatted` keys match the `data-field` attributes on the session list page (cancelled-amount, skipped-amount,
// attendance-rate).
//
// Several academic years: `status`, `session`, `pool`, `totals` and `slackToday` describe the focus year only (like the main
// screen: the current year, else the nearest upcoming one, else the latest archive); `marks` covers every year (like the
// session list); `years` lists every year with its role and `history` is the per-year cost / hours / slacking (like the
// statistics page). `secondary` is the second-currency text of the session / pool figures when a second currency is set.
//
// Field names under `formatted` match the `data-field` attributes on the dashboard, with the same two-decimal text.
// Local-time notions (today, days until term) use this computer's time zone, like the browser does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { billingStateAt, buildPools, findPoolOfSession, getPoolSession, poolStateAt, sessionStateAt, summarizeMarks, type Pool } from '../src/core/billing';
import { assignCourses, sessionsOfCourses } from '../src/core/courses';
import { expandIcs, mergeSessions } from '../src/core/ics/expand';
import { sessionOrdinal } from '../src/core/ordinal';
import { convert, formatAmountMinor, formatMinor, getCurrency, isCurrencyCode, type CurrencyCode, type RateTable } from '../src/core/money';
import { historySummary } from '../src/core/stats';
import { expandManual, manualFromDoc } from '../src/core/manual';
import { academicYearsOf, focusYearOf } from '../src/core/years';
import { academicYearOf } from '../src/core/academic';
import { slackAmountMinor, slackSeconds } from '../src/core/slack';
import { getStatus } from '../src/core/status';
import type { AcademicConfig, Course, MarkMap, Session, SlackRecord, TuitionConfig } from '../src/core/types';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(message: string): never {
  console.error(`Error: ${message}\nUsage: npm run query -- --now <ISO-8601> [--data-dir <dir>] [--tz <zone>]`);
  process.exit(2);
}

function parseArgs(argv: string[]): { now: string; dataDir: string; tz: string | null } {
  let tz: string | null = null;
  let now: string | null = null;
  let dataDir = process.env.TT_DATA_DIR ? path.resolve(process.env.TT_DATA_DIR) : path.join(root, 'data');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === '--now') now = value();
    else if (a === '--data-dir') dataDir = path.resolve(value());
    else if (a === '--tz') tz = value();
    else usage(`unknown option ${a}`);
  }
  if (now === null) usage('--now is required');
  return { now, dataDir, tz };
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const hms = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};
const midnight = (ms: number, plusDays = 0): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime();
};

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.tz) process.env.TZ = args.tz; // must happen before the first Date is created
  const nowMs = Date.parse(args.now.replace(/ (\d{2}:?\d{2})$/, '+$1'));
  if (!Number.isFinite(nowMs)) usage(`cannot parse --now ${args.now}`);

  const config = readJson(path.join(args.dataDir, 'config.json'));
  const marksDoc = readJson(path.join(args.dataDir, 'marks.json'));
  const slacksDoc = readJson(path.join(args.dataDir, 'slacks.json'));
  const calDir = path.join(args.dataDir, 'calendars');
  const files = fs.existsSync(calDir) ? fs.readdirSync(calDir).filter((f) => f.toLowerCase().endsWith('.ics')).sort() : [];
  if (files.length === 0 || !config.academic) {
    console.error('Error: the data folder has no finished setup (config.json with academic settings and at least one calendar).');
    process.exit(3);
  }

  const currency: CurrencyCode = isCurrencyCode(config.currency) ? config.currency : 'HKD';
  const courses = (config.courses ?? []) as Course[];
  const marks = (marksDoc.marks && typeof marksDoc.marks === 'object' ? marksDoc.marks : {}) as MarkMap;
  const records = (Array.isArray(slacksDoc.records) ? slacksDoc.records : []) as SlackRecord[];

  // Calendar classes plus the classes added by hand (the `manual` part of marks.json), like the app.
  const sessions: Session[] = mergeSessions([...files.map((f) => expandIcs(fs.readFileSync(path.join(calDir, f), 'utf8'))), expandManual(manualFromDoc(marksDoc.manual))]);
  const assigned = assignCourses(sessions, courses);
  const billable = sessionsOfCourses(sessions, courses).map((s) => ({ ...s, courseId: assigned.get(s.id) as string }));
  const creditMap: Record<string, number | null> = {};
  for (const c of courses) creditMap[c.id] = c.credits;
  const academic = config.academic as AcademicConfig;
  const allPools: Pool[] = billable.length
    ? buildPools(billable, { academic, mode: (config.billingMode as 'duration' | 'credit' | undefined) ?? 'duration', tuition: (config.tuition ?? { defaultMinor: null }) as TuitionConfig, credits: creditMap })
    : [];

  // The focus academic year (core years.ts): with more than one year the main-screen figures use that year only.
  const years = academicYearsOf(billable, academic, nowMs);
  const focusYear = focusYearOf(years);
  const scoped = years.length > 1 && focusYear !== null;
  const focusBillable = scoped ? billable.filter((s) => academicYearOf(s.startMs, academic) === focusYear) : billable;
  const pools: Pool[] = scoped ? allPools.filter((p) => p.year === focusYear) : allPools;

  const status = getStatus(nowMs, focusBillable, marks);
  const money = (minor: number): string => formatAmountMinor(minor);
  const symbol = getCurrency(currency).symbol;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const courseOf = (id: string): Course | undefined => courses.find((c) => c.id === id);

  const describe = (s: (typeof billable)[number]) => {
    const pool = findPoolOfSession(pools, s.id);
    const ps = pool ? getPoolSession(pool, s.id) : null;
    const st = pool ? sessionStateAt(pool, s.id, nowMs) : null;
    const course = courseOf(s.courseId);
    const ord = pool ? sessionOrdinal(pool.sessions, s.id) : null;
    const rate = ps?.ratePerSec ?? 0;
    const elapsedSec = Math.max(0, Math.floor((Math.min(nowMs, s.endMs) - s.startMs) / 1000));
    const remainingSec = Math.max(0, Math.ceil((s.endMs - nowMs) / 1000));
    const countdownSec = Math.max(0, Math.ceil((s.startMs - nowMs) / 1000));
    return {
      id: s.id,
      courseCode: course?.code ?? null,
      courseName: course?.name ?? s.title,
      index: ord?.index ?? null,
      total: ord?.total ?? null,
      startIso: iso(s.startMs),
      endIso: iso(s.endMs),
      costMinor: ps?.costMinor ?? 0,
      consumedMinor: st?.consumedMinor ?? 0,
      remainingMinor: st?.remainingMinor ?? 0,
      ratePerSecMinor: rate,
      elapsedSec,
      remainingSec,
      countdownSec,
      formatted: {
        'session-consumed': money(st?.consumedMinor ?? 0),
        'session-remaining': money(st?.remainingMinor ?? 0),
        'session-cost': formatMinor(ps?.costMinor ?? 0, currency),
        'rate-per-sec': `${symbol}${(rate / 100).toFixed(4)}`,
        elapsed: hms(elapsedSec),
        'time-left': hms(remainingSec),
        countdown: hms(countdownSec),
        'session-index': ord ? `${ord.index} / ${ord.total}` : '',
      },
    };
  };

  const current = status.current ? describe(status.current as (typeof billable)[number]) : null;
  const next = status.next ? describe(status.next as (typeof billable)[number]) : null;
  const prev = status.prev ? describe(status.prev as (typeof billable)[number]) : null;

  const ref = status.current ?? status.next ?? status.prev ?? null;
  const tankPool = (ref ? findPoolOfSession(pools, ref.id) : null) ?? pools[pools.length - 1] ?? null;
  const ps = tankPool ? poolStateAt(tankPool, nowMs) : null;
  const all = billingStateAt(pools, nowMs);

  const sessionById = new Map(focusBillable.map((s) => [s.id, s]));
  const todayIds = new Set(status.today.map((s) => s.id));
  let slackSec = 0;
  let slackMinor = 0;
  for (const r of records) {
    const s = sessionById.get(r.sessionId);
    if (!s || !todayIds.has(s.id)) continue;
    const pool = findPoolOfSession(pools, s.id);
    const rate = (pool ? getPoolSession(pool, s.id)?.ratePerSec : 0) ?? 0;
    slackSec += slackSeconds(r, s, nowMs);
    slackMinor += slackAmountMinor(r, s, rate, nowMs);
  }

  const markSummary = summarizeMarks(allPools, marks, { asOfMs: nowMs }).total;
  const daysUntilTerm = status.kind === 'before-term' && status.next ? Math.round((midnight(status.next.startMs) - midnight(nowMs)) / 86_400_000) : null;

  const out = {
    nowIso: iso(nowMs),
    nowMs,
    // This computer's UTC offset at `now` (minutes east of UTC); the browser must use the same one for day-based states.
    utcOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
    currency,
    status: status.kind,
    session: current,
    alsoActive: status.alsoActive.map((s) => s.id),
    next,
    prev,
    pool: tankPool && ps
      ? {
          key: tankPool.key,
          tuitionMinor: ps.tuitionMinor,
          consumedMinor: ps.consumedMinor,
          remainingMinor: ps.remainingMinor,
          progress: ps.progress,
          formatted: {
            'pool-tuition': money(ps.tuitionMinor),
            'pool-consumed': money(ps.consumedMinor),
            'pool-remaining': money(ps.remainingMinor),
            'pool-percent': (Math.min(1, Math.max(0, ps.progress)) * 100).toFixed(1),
          },
        }
      : null,
    totals: { tuitionMinor: all.tuitionMinor, consumedMinor: all.consumedMinor, remainingMinor: all.remainingMinor },
    marks: {
      endedSessions: markSummary.sessionCount,
      cancelledCount: markSummary.cancelledCount,
      skippedCount: markSummary.skippedCount,
      attendedCount: markSummary.attendedCount,
      cancelledMinor: markSummary.cancelledMinor,
      skippedMinor: markSummary.skippedMinor,
      attendanceRate: markSummary.attendanceRate,
      lateMinor: markSummary.lateMinor,
      earlyMinor: markSummary.earlyMinor,
      lateMinutes: markSummary.lateMinutes,
      earlyMinutes: markSummary.earlyMinutes,
      lostMinor: markSummary.lostMinor,
      // the same figures per academic year (the session list's cards follow the year of the shown week)
      byYear: years.map((y) => {
        const m = summarizeMarks(allPools.filter((p) => p.year === y.year), marks, { asOfMs: nowMs }).total;
        return { year: y.year, cancelledMinor: m.cancelledMinor, skippedMinor: m.skippedMinor, lateEarlyMinor: m.lateMinor + m.earlyMinor, attendanceRate: m.attendanceRate };
      }),
      formatted: {
        'late-early-amount': formatMinor(markSummary.lateMinor + markSummary.earlyMinor, currency),
        'cancelled-amount': formatMinor(markSummary.cancelledMinor, currency),
        'skipped-amount': formatMinor(markSummary.skippedMinor, currency),
        'attendance-rate': markSummary.attendanceRate === null ? '—' : `${Math.round(markSummary.attendanceRate * 100)}%`,
      },
    },
    focusYear,
    years: years.map((y) => ({ year: y.year, role: y.role, sessionCount: y.sessionCount })),
    history: (() => {
      const h = historySummary({ sessions: billable, pools: allPools, courses, marks, slacks: records, nowMs }, academic);
      return { years: h.years.map((y) => ({ year: y.year, costMinor: y.costMinor, sessionCount: y.sessionCount, slackMinor: y.slackMinor })), totalCostMinor: h.total.costMinor, totalSessionCount: h.total.sessionCount };
    })(),
    secondary: (() => {
      const code = config.secondaryCurrency;
      if (!isCurrencyCode(code) || code === currency) return null;
      const rates: RateTable = {};
      if (config.rates && typeof config.rates === 'object') for (const [k, v] of Object.entries(config.rates as Record<string, unknown>)) if (isCurrencyCode(k) && typeof v === 'number' && v > 0) rates[k] = v;
      const approx = (minor: number): string => `≈ ${formatMinor(Math.round(convert(minor, currency, code, rates)), code)}`;
      return { currency: code, 'session-consumed-second': current ? approx(current.consumedMinor) : null, 'pool-tuition-second': ps ? approx(ps.tuitionMinor) : null };
    })(),
    todaySessionCount: status.today.length,
    slackToday: { seconds: slackSec, amountMinor: slackMinor },
    daysUntilTerm,
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
