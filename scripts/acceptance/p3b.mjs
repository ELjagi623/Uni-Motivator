// P3b acceptance checks (dashboard and slacking). Standard numbers match .pipeline/PLAN.md: P3b.1 ... P3b.5.
// P3b.6 (visual) is not automated. P3b.3 automates its data half: the numbers of the UI state layer are compared with
// `npm run query` for a real data folder written through the real server (the browser half is in the dev report).

import fs from 'node:fs';
import path from 'node:path';
import { root, findFreeBase, httpRaw, makeTempDir, ok, fail, putDoc, requireVitest, runShell, startLocalServer } from './lib.mjs';

const fixture = path.join(root, 'tests', 'fixtures', 'full-term.ics');

// ------------------------------------------------------------------ P3b.1
async function p3b1() {
  return requireVitest(/^tests\/ui\/ticking\.test\.tsx$/, [
    'does not re-render while the time changes 60 times',
    'is in tabular figures, hidden from screen readers and not inside a live region',
    'TickingText updates in place too',
  ]);
}

// ------------------------------------------------------------------ P3b.2
async function p3b2() {
  const state = requireVitest(/^tests\/state\/dashboard\.test\.ts$/, [
    'covers all six states with the six instants',
    'the page state for "inClass" is the state core reports',
    'live values equal sessionStateAt / poolStateAt at the same instant',
    'keeps consumed + remaining equal to the tuition at 1000 instants',
    'lists every session in progress, the primary one first, and honours the chosen one',
  ]);
  if (!state.ok) return state;
  const ui = requireVitest(/^tests\/ui\/dashboard\.test\.tsx$/, [
    'at the beforeTerm instant the page shows before-term',
    'at the inClass instant the page shows in-class',
    'at the break instant the page shows break',
    'at the doneToday instant the page shows done-today',
    'at the noClassToday instant the page shows no-class-today',
    'at the afterTerm instant the page shows after-term',
    'in class: course, session i of N, unit price, consumed / remaining and the tank equal core',
    'overlapping classes get a switch button',
  ]);
  if (!ui.ok) return ui;
  const rest = requireVitest(/^tests\/(ui\/ticking\.test\.tsx|core\/ordinal\.test\.ts)$/, ['changes the line every 8 seconds and never repeats the previous line', 'counts a session among the sessions of its own course']);
  if (!rest.ok) return rest;
  return ok(`state layer: ${state.detail}; page: ${ui.detail}; carousel and session ordinal: ${rest.detail}`);
}

// ------------------------------------------------------------------ P3b.3 (data half)
const NOWS = [
  ['before-term', '2026-08-20T10:00:00+08:00'],
  ['in-class', '2026-11-12T10:30:00+08:00'],
  ['break', '2026-11-12T08:00:00+08:00'],
  ['done-today', '2026-11-12T14:00:00+08:00'],
  ['no-class-today', '2026-11-13T10:00:00+08:00'],
  ['after-term', '2027-05-10T10:00:00+08:00'],
];

const tsx = (script, args) => runShell(`npx tsx ${script} ${args.map((a) => `"${a}"`).join(' ')}`);
const cents = (text) => Math.round(Number(String(text).replace(/,/g, '')) * 100);

async function p3b3() {
  // 1. A data folder written the way the app writes it: through the server's HTTP API.
  const dataDir = makeTempDir('tt-accept-p3b-');
  const make = tsx('scripts/acceptance/p3b-make-config.ts', [fixture, 'cal-fixture']);
  if (make.status !== 0) return fail(`could not build the wizard config: ${make.output.trim().slice(-200)}`);
  const config = JSON.parse(make.stdout.trim().split('\n').at(-1));
  const port = await findFreeBase(1, 4470);
  const srv = startLocalServer(['--no-open', '--port', String(port), '--data-dir', dataDir]);
  try {
    await srv.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/);
    const put = await putDoc(port, 'config', 0, config);
    if (put.status !== 200) return fail(`PUT config -> ${put.status}`);
    const post = await httpRaw(port, { method: 'POST', path: '/api/calendars', headers: { 'X-Tuition-Ticker': '1', 'Content-Type': 'text/calendar' }, body: fs.readFileSync(fixture, 'utf8') });
    if (post.status !== 201) return fail(`POST /api/calendars -> ${post.status}`);
  } finally {
    await srv.kill();
  }
  if (!fs.existsSync(path.join(dataDir, 'config.json')) || fs.readdirSync(path.join(dataDir, 'calendars')).length !== 1) return fail('the server did not write config.json and calendars/*.ics');

  // 2. The UI state layer's numbers at six instants.
  const model = tsx('scripts/acceptance/p3b-model.ts', [dataDir, 'Asia/Hong_Kong', ...NOWS.map((n) => n[1])]);
  if (model.status !== 0) return fail(`state-layer script failed: ${model.output.trim().slice(-300)}`);
  const modelRows = JSON.parse(model.stdout.trim().split('\n').at(-1));

  // 3. `npm run query` (core only) at the same instants, compared field by field.
  const problems = [];
  let compared = 0;
  for (let i = 0; i < NOWS.length; i++) {
    const [expectedStatus, iso] = NOWS[i];
    const q = runShell(`npm run query --silent -- --now "${iso}" --data-dir "${dataDir}" --tz Asia/Hong_Kong`);
    if (q.status !== 0) {
      problems.push(`${expectedStatus}: query exited ${q.status}: ${q.output.trim().slice(-200)}`);
      continue;
    }
    const query = JSON.parse(q.stdout);
    const row = modelRows[i];
    if (query.status !== expectedStatus) problems.push(`${expectedStatus}: query says ${query.status}`);
    if (row.status !== expectedStatus) problems.push(`${expectedStatus}: page model says ${row.status}`);
    const source = { ...(query.pool?.formatted ?? {}), ...(query.session?.formatted ?? {}), ...(query.next && expectedStatus === 'break' ? { countdown: query.next.formatted.countdown } : {}) };
    for (const [name, value] of Object.entries(row.fields)) {
      compared++;
      if (source[name] !== value) problems.push(`${expectedStatus}: ${name} page-model "${value}" vs query "${source[name]}"`);
    }
    if (query.pool && cents(query.pool.formatted['pool-consumed']) + cents(query.pool.formatted['pool-remaining']) !== query.pool.tuitionMinor) problems.push(`${expectedStatus}: pool consumed + remaining != tuition`);
    if (expectedStatus === 'in-class') {
      for (const f of ['session-consumed', 'session-remaining', 'rate-per-sec', 'session-index', 'pool-consumed', 'pool-remaining']) if (!(f in row.fields)) problems.push(`in-class: field ${f} missing in the page model`);
      if (query.session.consumedMinor + query.session.remainingMinor !== query.session.costMinor) problems.push('in-class: session consumed + remaining != cost');
    }
    if (expectedStatus === 'before-term' && row.daysUntilTerm !== query.daysUntilTerm) problems.push(`before-term: days until term ${row.daysUntilTerm} vs ${query.daysUntilTerm}`);
  }
  if (problems.length) return fail(problems.slice(0, 5).join('; '));
  return ok(`6 instants x (status + page-model fields vs query): ${compared} fields identical, consumed + remaining == tuition each time; data folder written through POST/PUT on the real server (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P3b.4
async function p3b4() {
  return requireVitest(/^tests\/ui\/dashboard\.test\.tsx$/, [
    'writes the record with PUT slacks first, and only then shows the slacking page',
    'restores an unfinished slacking session after a reload, with the amount for the time that has passed',
    'closes a record whose class is over at the end time of the class',
    'turns the slacking page into the settlement card when the class ends meanwhile',
    '"continue the lecture" writes endMs and shows the settlement card with the amount core gives',
  ]);
}

// ------------------------------------------------------------------ P3b.5
async function p3b5() {
  const v = requireVitest(/^tests\/ui\/dashboard\.test\.tsx$/, [
    'shows "HK$2,287 · MFIN7002" in class and "🐟 HK$x.xx" while slacking, and the app name otherwise',
    'has an aria-live="polite" summary that changes at most once in 60 seconds; ticking numbers are not live',
    'demo mode shows an in-class dashboard from the sample timetable without writing anything, and exits to the wizard',
  ]);
  if (!v.ok) return v;
  const sample = path.join(root, 'examples', 'sample-calendar.ics');
  if (!fs.existsSync(sample)) return fail('examples/sample-calendar.ics is missing');
  const text = fs.readFileSync(sample, 'utf8');
  if (!text.includes('BEGIN:VCALENDAR') || !/example/i.test(text)) return fail('examples/sample-calendar.ics does not look like the fictional sample');
  return ok(`${v.detail}; examples/sample-calendar.ics present`);
}

export const checks = [
  { id: 'P3b.1', title: 'TickingNumber does not re-render', run: p3b1 },
  { id: 'P3b.2', title: 'state mapping and number sources (6 instants, overlap, carousel)', run: p3b2 },
  { id: 'P3b.3', title: 'page-model numbers = query (data half, real data folder)', run: p3b3 },
  { id: 'P3b.4', title: 'slacking lifecycle (PUT first, restore, auto-close, settlement)', run: p3b4 },
  { id: 'P3b.5', title: 'tab title, aria-live, demo mode', run: p3b5 },
];
