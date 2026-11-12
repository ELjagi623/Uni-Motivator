// `npm run inspect` - run the core engine over real calendar files and print what it makes of them.
//
//   npm run inspect -- --tuition 398000 --currency HKD [--period semester|year] [--dir DIR | --file FILE]
//                      [--region northern|southern] [--year-start MM-DD --split-date MM-DD] [--redact] [--json]
//
// --redact prints NO titles, course codes, locations, dates or times: courses become "Course#n", pools "Pool#n",
// and only counts, durations, unit prices, split-check verdicts and invariant results are shown. Use it whenever the
// output may end up in a report. File names are never printed in redact mode either.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSplitDate, type SplitCheck } from '../src/core/academic';
import { billingStateAt, buildPools, poolStateAt, type Pool } from '../src/core/billing';
import { courseFromGroup, groupSessions, sessionsOfCourses } from '../src/core/courses';
import { expandIcs, mergeSessions } from '../src/core/ics/expand';
import { readCalendarFile } from '../src/core/ics/unzip';
import { formatMinor, getCurrency, isCurrencyCode, majorToMinor, type CurrencyCode } from '../src/core/money';
import type { AcademicConfig, Session } from '../src/core/types';
import { getRegionPreset } from '../src/data/regions';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  dir: string;
  file: string | null;
  tuitionMajor: string | null;
  currency: CurrencyCode;
  period: 'semester' | 'year';
  region: 'northern' | 'southern';
  yearStart: string | null;
  splitDate: string | null;
  redact: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    dir: path.join(root, 'test-data', 'private'),
    file: null,
    tuitionMajor: null,
    currency: 'HKD',
    period: 'semester',
    region: 'northern',
    yearStart: null,
    splitDate: null,
    redact: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--dir': o.dir = path.resolve(value()); break;
      case '--file': o.file = path.resolve(value()); break;
      case '--tuition': o.tuitionMajor = value(); break;
      case '--currency': {
        const c = value().toUpperCase();
        if (!isCurrencyCode(c)) throw new Error(`unknown currency ${c}`);
        o.currency = c;
        break;
      }
      case '--period': {
        const p = value();
        if (p !== 'semester' && p !== 'year') throw new Error('--period must be semester or year');
        o.period = p;
        break;
      }
      case '--region': {
        const r = value();
        if (r !== 'northern' && r !== 'southern') throw new Error('--region must be northern or southern');
        o.region = r;
        break;
      }
      case '--year-start': o.yearStart = value(); break;
      case '--split-date': o.splitDate = value(); break;
      case '--redact': o.redact = true; break;
      case '--json': o.json = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

function listInputFiles(o: Options): string[] {
  if (o.file) return [o.file];
  if (!fs.existsSync(o.dir)) return [];
  return fs
    .readdirSync(o.dir)
    .filter((f) => /\.(zip|ics)$/i.test(f))
    .sort()
    .map((f) => path.join(o.dir, f));
}

const hours = (sec: number): string => (sec / 3600).toFixed(1);
const days = (ms: number): string => (ms / 86_400_000).toFixed(0);

function main(): number {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 2;
  }
  if (o.tuitionMajor === null) {
    console.error('Error: --tuition <amount in major units, e.g. 398000> is required');
    return 2;
  }
  const tuitionMinor = majorToMinor(o.tuitionMajor);
  if (tuitionMinor === null) {
    console.error('Error: --tuition is not a valid amount');
    return 2;
  }

  const files = listInputFiles(o);
  if (files.length === 0) {
    console.error(o.redact ? 'Error: no calendar files found' : `Error: no .zip / .ics files found in ${o.file ?? o.dir}`);
    return 3;
  }

  // 1. parse
  const lists: Session[][] = [];
  let calendars = 0;
  let failedCalendars = 0;
  for (const file of files) {
    let entries;
    try {
      entries = readCalendarFile(path.basename(file), new Uint8Array(fs.readFileSync(file)));
    } catch {
      failedCalendars++;
      continue;
    }
    for (const entry of entries) {
      calendars++;
      try {
        lists.push(expandIcs(entry.text));
      } catch {
        failedCalendars++;
      }
    }
  }
  const sessions = mergeSessions(lists);

  // 2. courses
  const groups = groupSessions(sessions);
  const suggested = groups.filter((g) => g.suggested);
  const courses = suggested.map((g, i) => courseFromGroup(g, { colorIndex: i }));
  const billable = sessionsOfCourses(sessions, courses);

  // 3. academic + billing
  const preset = getRegionPreset(o.region);
  const academic: AcademicConfig = {
    yearStart: o.yearStart ?? preset.yearStart,
    splitDate: o.splitDate ?? preset.splitDate,
    billingPeriod: o.period,
  };
  const pools = billable.length ? buildPools(billable, { academic, tuition: { defaultMinor: tuitionMinor } }) : [];
  const split = billable.length ? checkSplitDate(billable, academic) : [];

  // 4. invariants
  const failures = checkInvariants(billable, pools, tuitionMinor);

  const cur = o.currency;
  const fmt = (minor: number) => formatMinor(minor, cur);
  const perSecond = (p: Pool) => `${getCurrency(cur).symbol}${(p.averageRatePerSec / 100).toFixed(4)}`;
  const verdict = (s: SplitCheck) => (s.status === 'ok' ? 'INSIDE_GAP' : s.status === 'suggest' ? 'SUGGEST_CHANGE' : s.status === 'single-semester' ? 'SINGLE_SEMESTER' : 'NO_GAP');

  const summary = {
    files: files.length,
    calendars,
    failedCalendars,
    sessions: sessions.length,
    groups: groups.length,
    suggestedGroups: suggested.length,
    billableSessions: billable.length,
    pools: pools.length,
    splitChecks: split.map(verdict),
    invariants: failures.length === 0 ? 'PASS' : 'FAIL',
  };

  if (o.json) {
    const payload = {
      ...summary,
      failures,
      groups: groups.map((g, i) => ({
        name: o.redact ? `Course#${i + 1}` : g.name,
        code: o.redact ? null : g.code,
        count: g.count,
        totalHours: Number(hours(g.totalSeconds)),
        suggested: g.suggested,
        reason: g.reason,
      })),
      pools: pools.map((p, i) => ({
        key: o.redact ? `Pool#${i + 1}` : p.key,
        sessions: p.sessions.length,
        totalHours: Number(hours(p.totalSeconds)),
        tuitionMinor: p.tuitionMinor,
        ratePerSecondMajor: p.averageRatePerSec / 100,
        averageSessionCostMinor: Math.round((p.tuitionMinor ?? 0) / p.sessions.length),
      })),
      split: split.map((s, i) => ({
        year: o.redact ? `Year#${i + 1}` : s.year,
        status: s.status,
        gapDays: s.gapFromMs !== undefined && s.gapToMs !== undefined ? Number(days(s.gapToMs - s.gapFromMs)) : null,
        suggestedSplit: o.redact ? undefined : s.suggestedSplit,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return failures.length === 0 && suggested.length > 0 ? 0 : 1;
  }

  const out: string[] = [];
  out.push(`SESSIONS: ${summary.sessions}`);
  out.push(`CALENDARS: ${summary.calendars}${failedCalendars ? ` (${failedCalendars} failed to parse)` : ''}`);
  out.push(`GROUPS: ${summary.groups}`);
  out.push(`SUGGESTED_GROUPS: ${summary.suggestedGroups}`);
  out.push(`BILLABLE_SESSIONS: ${summary.billableSessions}`);
  out.push('');
  out.push('Course groups (suggested first):');
  groups.forEach((g, i) => {
    const label = o.redact ? `Course#${i + 1}` : `${g.name}${g.code ? ` [${g.code}]` : ''}`;
    out.push(`  [${g.suggested ? 'x' : ' '}] ${label}: ${g.count} sessions, ${hours(g.totalSeconds)} h${g.suggested ? '' : ` (${g.reason})`}`);
  });
  out.push('');
  out.push(`Tuition per ${o.period}: ${fmt(tuitionMinor)}   academic year starts ${o.redact ? '(hidden)' : academic.yearStart}, split ${o.redact ? '(hidden)' : academic.splitDate}`);
  out.push(`POOLS: ${pools.length}`);
  pools.forEach((p, i) => {
    const label = o.redact ? `Pool#${i + 1}` : p.key;
    const avg = fmt(Math.round(tuitionMinor / p.sessions.length));
    const range = o.redact ? '' : `, ${new Date(p.firstStartMs).toLocaleDateString('en-CA')} .. ${new Date(p.lastEndMs).toLocaleDateString('en-CA')}`;
    out.push(`  ${label}: ${p.sessions.length} sessions, ${hours(p.totalSeconds)} h, cost per second ${perSecond(p)}, average per session ${avg}${range}`);
  });
  out.push('');
  split.forEach((s, i) => {
    const gap = s.gapFromMs !== undefined && s.gapToMs !== undefined ? `, longest gap ${days(s.gapToMs - s.gapFromMs)} days` : '';
    const label = o.redact ? `Year#${i + 1}` : String(s.year);
    const hint = s.status === 'suggest' ? (o.redact ? ' (change the split date; value hidden in redact mode)' : ` (suggest split date ${s.suggestedSplit})`) : '';
    out.push(`SPLIT_CHECK ${label}: ${verdict(s)}${gap}${hint}`);
  });
  out.push('');
  for (const f of failures) out.push(`  invariant violated: ${f}`);
  out.push(`INVARIANTS: ${summary.invariants}`);
  console.log(out.join('\n'));
  if (suggested.length === 0) {
    console.error('No course group was suggested; nothing to bill.');
    return 1;
  }
  return failures.length === 0 ? 0 : 1;
}

/** Billing invariants over the real data. Returns human-readable failures (empty = all good). */
function checkInvariants(billable: Session[], pools: Pool[], tuitionMinor: number): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  let poolTotal = 0;
  for (const p of pools) {
    poolTotal += p.sessions.length;
    for (const s of p.sessions) {
      if (seen.has(s.id)) failures.push('a session belongs to more than one pool');
      seen.add(s.id);
    }
  }
  if (poolTotal !== billable.length) failures.push(`pools hold ${poolTotal} sessions but ${billable.length} are billable`);

  pools.forEach((p, idx) => {
    const tag = `Pool#${idx + 1}`;
    const costSum = p.sessions.reduce((a, s) => a + s.costMinor, 0);
    if (Math.abs(costSum - tuitionMinor) > 1) failures.push(`${tag}: per-session costs sum to ${costSum}, tuition is ${tuitionMinor}`);
    const exactSum = p.sessions.reduce((a, s) => a + s.costExact, 0);
    if (Math.abs(exactSum - tuitionMinor) > 1) failures.push(`${tag}: exact costs sum differs from the tuition by more than 1 minor unit`);

    const span = p.lastEndMs - p.firstStartMs;
    let prev = -1;
    for (let i = -2; i <= 400; i++) {
      const now = i === -2 ? p.firstStartMs - 1 : i === 400 ? p.lastEndMs + 1 : p.firstStartMs + Math.round((span * i) / 399);
      const st = poolStateAt(p, now);
      if (st.consumedMinor + st.remainingMinor !== tuitionMinor) failures.push(`${tag}: consumed + remaining != tuition`);
      if (st.consumedMinor < prev) failures.push(`${tag}: consumption decreased`);
      prev = st.consumedMinor;
    }
    if (poolStateAt(p, p.firstStartMs - 1).consumedMinor !== 0) failures.push(`${tag}: not 0 before the first session`);
    const end = poolStateAt(p, p.lastEndMs);
    if (end.consumedMinor !== tuitionMinor || end.progress !== 1) failures.push(`${tag}: not fully consumed at the end`);
  });
  const total = billingStateAt(pools, Number.MAX_SAFE_INTEGER);
  if (pools.length && total.consumedMinor !== tuitionMinor * pools.length) failures.push('total consumed after the last session != total tuition');
  return [...new Set(failures)];
}

process.exitCode = main();
