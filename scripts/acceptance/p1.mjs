// P1 acceptance checks (core engine). Standard numbers match .pipeline/PLAN.md: P1.1 ... P1.6.
// They chain the existing Vitest suites (run once, JSON reporter) instead of re-implementing the logic.

import fs from 'node:fs';
import path from 'node:path';
import { root, makeTempDir, npmTestOnce, requireVitest, runShell, vitestRows, ok, fail } from './lib.mjs';

// ------------------------------------------------------------------ P1.1
async function p11() {
  const test = npmTestOnce();
  if (test.status !== 0) return fail(`npm test exited ${test.status}`);

  const cov = runShell('npm run coverage');
  if (cov.status !== 0) return fail(`npm run coverage exited ${cov.status}: ${cov.output.trim().split('\n').slice(-6).join(' | ')}`);
  const summaryFile = path.join(root, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(summaryFile)) return fail('coverage/coverage-summary.json missing');
  const total = JSON.parse(fs.readFileSync(summaryFile, 'utf8')).total;
  const low = ['lines', 'statements', 'functions'].filter((k) => total[k].pct < 90).map((k) => `${k} ${total[k].pct}%`);
  if (low.length) return fail(`src/core coverage below 90%: ${low.join(', ')}`);
  const files = Object.keys(JSON.parse(fs.readFileSync(summaryFile, 'utf8'))).filter((k) => k !== 'total' && /src[\\/]core[\\/]/.test(k));
  if (files.length < 10) return fail(`coverage covers only ${files.length} src/core files`);

  const arch = runShell('npm run check:arch');
  if (arch.status !== 0) return fail(`check:arch exited ${arch.status}: ${arch.output.trim().split('\n').slice(-4).join(' | ')}`);
  const m = arch.output.match(/src\/core\/ : (\d+) files checked, (\d+) violations/);
  if (!m || Number(m[1]) < 10 || Number(m[2]) !== 0) return fail(`check:arch did not scan core properly: ${m ? m[0] : 'no core line'}`);

  return ok(`npm test and coverage pass; core coverage lines ${total.lines.pct}% / statements ${total.statements.pct}% / functions ${total.functions.pct}% over ${files.length} files; check:arch scanned ${m[1]} core files, 0 violations (no Date.now(), no argument-less new Date(), no DOM/network)`);
}

// ------------------------------------------------------------------ P1.2
async function p12() {
  return requireVitest(/^tests\/core\/billing\.test\.ts$/, [
    'holds consumed + remaining === tuition, monotonicity and the boundary values at 1500+ instants', // >= 1000 random + boundary nows, strict equality
    'is 0 before the first class and the full tuition after the last class',
    'matches an independent brute-force computation',
    'reproduces 0.3685 per second and HK$3,980.00 per session',
    'always add up to exactly the tuition',
    'keeps cancelled and skipped sessions in the denominator',
    'summarises school-swallowed tuition, skipped loss, late / early loss and attendance (hand-calculated)',
    'splits the tuition by credits, then by duration inside each course',
    'satisfies every invariant', // credit mode
    'works across the semester pools of the full-term calendar, with courses of different credits',
  ]);
}

// ------------------------------------------------------------------ P1.3
async function p13() {
  const r1 = requireVitest(/^tests\/core\/ics\/(expand|unzip)\.test\.ts$/, [
    'expands a weekly VTIMEZONE-based series',
    'resolves a TZID without VTIMEZONE',
    'leaves no session on the excluded date',
    'uses the new time for a moved occurrence but keeps the id of the original start',
    'matches an exception whose RECURRENCE-ID is written in UTC',
    'shifts the UTC hour by one across the London daylight-saving change',
    'treats floating times as the computer time zone',
    'drops all-day events',
    'drops CANCELLED events',
    'keeps the full duration of a class that crosses midnight',
    'keeps overlapping classes as two sessions',
    'identical after re-parsing',
    'produces text that the parser expands (zip -> sessions)',
    'has 58 sessions',
  ]);
  if (!r1.ok) return r1;
  const r2 = requireVitest(/^tests\/core\/courses\.test\.ts$/, [
    'puts Lecture, Tutorial and "COMP 3230 Lab" into one group',
    'does not suggest exam / holiday / office-hour groups',
    're-attaches sessions after a re-import by code and by title',
  ]);
  if (!r2.ok) return r2;
  const { rows } = vitestRows();
  const fixtures = fs.readdirSync(path.join(root, 'tests', 'fixtures')).filter((f) => f.endsWith('.ics'));
  if (fixtures.length < 11) return fail(`only ${fixtures.length} fixtures in tests/fixtures`);
  return ok(`${rows.filter((r) => /^tests\/core\/(ics\/|courses)/.test(r.file)).length} ics/course tests pass; ${fixtures.length} fixtures incl. full-term.ics; all required fixture cases present`);
}

// ------------------------------------------------------------------ P1.4
async function p14() {
  const a = requireVitest(/^tests\/core\/academic\.test\.ts$/, [
    'a session starting at 00:00 local on the split date belongs to semester 2, the previous day to semester 1',
    'a session that spans the split date is assigned by its start time',
    'southern preset',
    'gives no suggestion when the split date lies inside the winter break',
    'suggests the middle of the longest gap when the split date falls inside a semester',
    'puts every session of the full-term calendar into exactly one pool',
  ]);
  if (!a.ok) return a;
  const s = requireVitest(/^tests\/core\/status\.test\.ts$/, [
    'before-term: weeks before the first class',
    'in-class: 10:30 on a Thursday',
    'break: between two classes on the same day',
    'done-today: after the last class of a class day',
    'no-class-today: a weekday without class',
    'after-term: after the last class of the calendar',
    'prefers the session that is not marked as skipped',
  ]);
  if (!s.ok) return s;
  const k = requireVitest(/^tests\/core\/slack\.test\.ts$/, [
    'counts a running record up to `now`',
    'does not count time beyond the end of the class',
    'sets endMs to the class end once the class is over',
  ]);
  if (!k.ok) return k;
  return ok('academic / status / slack suites pass, including the split-date, southern-preset, six-state, overlap-priority and slack-truncation cases');
}

// ------------------------------------------------------------------ P1.5
async function p15() {
  const m = requireVitest(/^tests\/core\/money\.test\.ts$/, [
    'formats all 7 currencies',
    'round trips with an error far below one cent for every pair of currencies',
    'converts typed amounts without floating-point error',
  ]);
  if (!m.ok) return m;
  const e = requireVitest(/^tests\/core\/equivalents\.test\.ts$/, [
    'HK$3,980 buys 88 boxes',
    'returns the most expensive item not exceeding the amount',
    'falls back to the cheapest item',
  ]);
  if (!e.ok) return e;
  const c = requireVitest(/^tests\/core\/copy\.test\.ts$/, [
    'renders every template without leaving',
    'never repeats the previous line',
    'has 3 intensities x 4 scenes x at least 10 templates',
  ]);
  if (!c.ok) return c;
  const d = requireVitest(/^tests\/core\/data\.test\.ts$/, ['has at least 15 price items', 'has the two region presets', 'has 7 currencies']);
  if (!d.ok) return d;
  return ok('money / equivalents / copy / data suites pass (7 currencies, round trip < 0.01, 88 boxes for 3,980 / 45, no leftover braces, no repeat, counts met)');
}

// ------------------------------------------------------------------ P1.6
async function p16() {
  // The suite must be reported as skipped (not failed) when the directory has no calendars.
  const emptyDir = makeTempDir('tt-accept-empty-');
  const skipOut = path.join(emptyDir, 'skip-results.json');
  const skipRun = runShell(`npx vitest run tests/core/private-calendar.test.ts --reporter=json --outputFile="${skipOut}"`, { env: { ...process.env, TT_PRIVATE_DIR: emptyDir } });
  let skipStatuses = [];
  try {
    const json = JSON.parse(fs.readFileSync(skipOut, 'utf8'));
    skipStatuses = json.testResults.flatMap((f) => f.assertionResults.map((t) => t.status));
  } catch {
    return fail('could not read the Vitest JSON for the empty-directory run');
  }
  if (skipRun.status !== 0 || skipStatuses.length === 0 || skipStatuses.some((s) => s === 'failed' || s === 'passed')) {
    return fail(`with an empty private directory the real-calendar suite should be skipped (statuses: ${[...new Set(skipStatuses)].join(',')}, exit ${skipRun.status})`);
  }

  const priv = path.join(root, 'test-data', 'private');
  const present = fs.existsSync(priv) && fs.readdirSync(priv).some((f) => /\.(zip|ics)$/i.test(f));
  if (!present) return ok('test-data/private has no calendar files: real-calendar checks skipped (suite reported as skipped, not failed)');

  const inspect = runShell('npm run inspect -- --tuition 398000 --currency HKD --redact');
  if (inspect.status !== 0) {
    // Only aggregate lines are echoed: the redacted output carries no calendar content.
    const lines = inspect.output.split('\n').filter((l) => /^(INVARIANTS|SUGGESTED_GROUPS|SESSIONS|Error|No course)/.test(l));
    return fail(`inspect --redact exited ${inspect.status}: ${lines.join(' | ')}`);
  }
  const out = inspect.stdout;
  const num = (label) => Number((out.match(new RegExp(`^${label}: (\\d+)`, 'm')) ?? [])[1]);
  if (!/^INVARIANTS: PASS$/m.test(out)) return fail('inspect --redact did not print "INVARIANTS: PASS"');
  const suggested = num('SUGGESTED_GROUPS');
  const sessions = num('SESSIONS');
  const billable = num('BILLABLE_SESSIONS');
  if (!(suggested >= 1)) return fail('no course group was suggested');
  if (!(sessions > 0 && billable > 0 && billable <= sessions)) return fail(`implausible counts (sessions ${sessions}, billable ${billable})`);
  const splits = [...out.matchAll(/^SPLIT_CHECK [^:]*: (\w+)/gm)].map((m) => m[1]);
  if (splits.length === 0 || splits.some((v) => !['INSIDE_GAP', 'SUGGEST_CHANGE', 'SINGLE_SEMESTER', 'NO_GAP'].includes(v))) return fail('split-date verdicts missing or unknown');
  // Leak guard: redacted output must not contain dates or times.
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(out) || /\b\d{1,2}:\d{2}\b/.test(out)) return fail('redacted inspect output contains something that looks like a date or time');

  const { rows } = vitestRows();
  const priv_rows = rows.filter((r) => r.file === 'tests/core/private-calendar.test.ts');
  if (priv_rows.length === 0 || priv_rows.some((r) => r.status !== 'passed')) return fail(`real-calendar Vitest suite did not fully pass (${priv_rows.length} tests, ${priv_rows.filter((r) => r.status !== 'passed').length} not passed)`);

  return ok(`inspect --redact: INVARIANTS PASS, ${sessions} sessions, ${suggested} suggested course group(s), ${billable} billable sessions each in exactly one pool, split-check verdicts ${[...new Set(splits)].join('/')}; real-calendar Vitest suite passes (${priv_rows.length} tests); no dates or times in redacted output`);
}

export const checks = [
  { id: 'P1.1', title: 'npm test, core coverage >= 90%, check:arch', run: p11 },
  { id: 'P1.2', title: 'billing correctness and invariants', run: p12 },
  { id: 'P1.3', title: 'calendar parsing / expansion fixtures and course identification', run: p13 },
  { id: 'P1.4', title: 'academic year, state machine and slacking', run: p14 },
  { id: 'P1.5', title: 'currency, equivalents, copy and built-in data', run: p15 },
  { id: 'P1.6', title: 'real calendar (redacted), skipped when absent', run: p16 },
];
