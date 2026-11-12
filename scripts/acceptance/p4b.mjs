// P4b acceptance checks (peek-proof mode, theme, second currency, credit weighting, several academic years).
// Standard numbers match .pipeline/PLAN.md: P4b.1 ... P4b.5. P4b.6 (visual) is not automated.
//
// The page-level checks run the Vitest suites (happy-dom renders the whole <App /> on a fake server); the data halves of
// P4b.2 / P4b.4 / P4b.5 use the real server and `npm run query` (core, independent of the UI state layer) as testers do.
// Real-browser halves (CSS blur actually rendering, prefers-color-scheme, first paint without flicker) are in the dev report.

import fs from 'node:fs';
import path from 'node:path';
import { root, findFreeBase, httpRaw, makeTempDir, ok, fail, putDoc, requireVitest, runShell, startLocalServer } from './lib.mjs';

const fullTerm = path.join(root, 'tests', 'fixtures', 'full-term.ics');
const nextYear = path.join(root, 'tests', 'fixtures', 'next-year.ics');
const tsx = (script, args) => runShell(`npx tsx ${script} ${args.map((a) => `"${a}"`).join(' ')}`);
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));
const cents = (text) => Math.round(Number(String(text).replace(/,/g, '')) * 100);
const WRITE = { 'X-Tuition-Ticker': '1' };

function makeConfig(mode) {
  const r = tsx('scripts/acceptance/p4b-make-config.ts', [fullTerm, nextYear, ...(mode ? [mode] : [])]);
  if (r.status !== 0) throw new Error(`could not build the config: ${r.output.trim().slice(-200)}`);
  return lastJson(r.stdout);
}

async function withServer(dataDir, fn) {
  const port = await findFreeBase(1, 4640);
  const srv = startLocalServer(['--no-open', '--port', String(port), '--data-dir', dataDir]);
  try {
    await srv.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/);
    return await fn(port);
  } finally {
    await srv.kill();
  }
}

const postCalendar = (port, file) => httpRaw(port, { method: 'POST', path: '/api/calendars', headers: { ...WRITE, 'Content-Type': 'text/calendar' }, body: fs.readFileSync(file, 'utf8') });

function query(dataDir, iso) {
  const q = runShell(`npm run query --silent -- --now "${iso}" --data-dir "${dataDir}" --tz Asia/Hong_Kong`);
  return q.status === 0 ? JSON.parse(q.stdout) : null;
}

// ------------------------------------------------------------------ P4b.1
async function p4b1() {
  const unit = requireVitest(/^tests\/state\/privacy\.test\.ts$/, [
    'puts data-privacy="on" on the root element, a second B takes it off again',
    'typing a b in an input, a textarea, a select or an editable element does not trigger it',
    'only a plain B counts',
    'is not saved anywhere: nothing is written to storage, and a fresh load starts with the mode off',
    'the stylesheet blurs every .money element while data-privacy is on',
  ]);
  if (!unit.ok) return unit;
  const pages = requireVitest(/^tests\/ui\/p4b\.test\.tsx$/, [
    'B blurs every amount on the dashboard: in class',
    'B blurs every amount on the dashboard: before the term',
    'B blurs every amount on the dashboard: after the term',
    'B blurs every amount on the session list',
    'B blurs every amount on the statistics',
    'B blurs every amount on the settings',
    'the tab title shows no amount while the mode is on',
  ]);
  if (!pages.ok) return pages;
  return ok(`key B: ${unit.detail}; every page audited (no amount-looking text or tuition field outside a .money element, 9 screens): ${pages.detail}; real-browser blur: see dev report`);
}

// ------------------------------------------------------------------ P4b.2
async function p4b2() {
  const ui = requireVitest(/^tests\/ui\/p4b\.test\.tsx$/, [
    'the settings offer follow-system / light / dark; the choice sets data-theme at once and is written to the config',
    'the saved choice is applied again after a reload',
    '"follow the system" leaves no data-theme',
    'has a classic inline script in the head, ahead of the app module',
    'sets data-theme from the saved choice, and leaves it alone for "system", nothing saved or blocked storage',
  ]);
  if (!ui.ok) return ui;
  const tokens = runShell('npm run check:tokens');
  if (tokens.status !== 0) return fail(`check:tokens failed: ${tokens.output.trim().slice(-200)}`);

  // data half: the choice lives in config.json on disk and survives a server restart
  const dataDir = makeTempDir('tt-accept-p4b2-');
  const config = { ...makeConfig(), theme: 'dark' };
  await withServer(dataDir, async (port) => {
    const put = await putDoc(port, 'config', 0, config);
    if (put.status !== 200) throw new Error(`PUT config -> ${put.status}`);
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  if (onDisk.theme !== 'dark') return fail(`config.json has theme ${onDisk.theme}, expected dark`);
  const after = await withServer(dataDir, async (port) => (await httpRaw(port, { path: '/api/data' })).json?.config?.theme);
  if (after !== 'dark') return fail(`after a restart the server answers theme ${after}`);

  // the built app (when it exists) keeps the inline script
  const built = path.join(root, 'app', 'index.html');
  let builtNote = 'no app/ build present (the source index.html is what the unit test checks)';
  if (fs.existsSync(built)) {
    const html = fs.readFileSync(built, 'utf8');
    if (!html.includes('tt.theme')) return fail('app/index.html (the build) lost the inline theme script');
    if (html.indexOf('tt.theme') > html.indexOf('type="module"')) return fail('in app/index.html the theme script comes after the app module');
    builtNote = 'the build app/index.html keeps the inline theme script ahead of the module';
  }
  return ok(`theme: ${ui.detail}; check:tokens still passes; config.json on disk and after a server restart holds the choice; ${builtNote}; prefers-color-scheme in a real browser: see dev report`);
}

// ------------------------------------------------------------------ P4b.3
async function p4b3() {
  const core = requireVitest(/^tests\/core\/rates\.test\.ts$/, [
    'the pair rate follows the built-in table',
    'zero, negative, NaN, infinite rates and a currency against itself are refused',
    'parses typed rates',
  ]);
  if (!core.ok) return core;
  const ui = requireVitest(/^tests\/ui\/p4b\.test\.tsx$/, [
    'shows "≈ amount" under the main number = core convert(main, main currency, second) formatted, and the main number is unchanged',
    'a rate of 0 or below is refused (error shown, nothing saved); a good rate is saved and the display updates at once',
    'the settings choose the second currency (never the main one) and show the rate table date',
    '"restore built-in rates" removes the manual rates',
    'the second currency also appears under the term figures of the non-class screens',
  ]);
  if (!ui.ok) return ui;
  return ok(`rates: ${core.detail}; settings and pages: ${ui.detail}`);
}

// ------------------------------------------------------------------ P4b.4
const NOW_Y1 = '2026-11-12T10:30:00+08:00'; // Thursday, MFIN7002 10:00-13:00 (2026 S1)

async function p4b4() {
  const ui = requireVitest(/^tests\/ui\/p4b\.test\.tsx$/, [
    'the settings have a mode switch and a credits field per course (positive numbers only)',
    'switching to credit mode asks "unit price from X to Y" per course (X, Y = core in both modes)',
    'credits typed in duration mode change no price: saved at once, without the confirmation dialog',
  ]);
  if (!ui.ok) return ui;
  const wizard = requireVitest(/^tests\/state\/credits\.test\.tsx$/, [
    'empty = not set; a number greater than zero is a credit value; everything else is invalid',
    'the recognition list shows an error under a credits field that is not a positive number',
  ]);
  if (!wizard.ok) return wizard;

  // data half: the same course, the same minute, the two modes: hand-computed unit prices from query (core), and consumed + remaining = tuition
  const dataDir = makeTempDir('tt-accept-p4b4-');
  const problems = [];
  await withServer(dataDir, async (port) => {
    if ((await postCalendar(port, fullTerm)).status !== 201) throw new Error('POST calendar failed');
    if ((await putDoc(port, 'config', 0, makeConfig())).status !== 200) throw new Error('PUT duration config failed');
    const dur = query(dataDir, NOW_Y1);
    if (!dur?.session) throw new Error('query failed (duration)');
    // 29 classes of 3 hours in 2026 S1: 398,000.00 / 313,200 s
    const expectedDur = `HK$${(39_800_000 / 100 / 313_200).toFixed(4)}`;
    if (dur.session.formatted['rate-per-sec'] !== expectedDur) problems.push(`duration price ${dur.session.formatted['rate-per-sec']}, hand ${expectedDur}`);
    if ((await putDoc(port, 'config', 1, makeConfig('credit'))).status !== 200) throw new Error('PUT credit config failed');
    const cre = query(dataDir, NOW_Y1);
    if (!cre?.session) throw new Error('query failed (credit)');
    // MFIN7002 has 1 of 5 credits in 2026 S1 and 14 classes of 3 hours: 398,000.00 x 1/5 / (14 x 10,800 s)
    const expectedCre = `HK$${((39_800_000 / 5 / (14 * 10_800)) / 100).toFixed(4)}`;
    if (cre.session.formatted['rate-per-sec'] !== expectedCre) problems.push(`credit price ${cre.session.formatted['rate-per-sec']}, hand ${expectedCre}`);
    if (cre.session.formatted['rate-per-sec'] === dur.session.formatted['rate-per-sec']) problems.push('the unit price did not change with the mode');
    for (const iso of [NOW_Y1, '2026-09-20T12:00:00+08:00', '2026-12-31T23:00:00+08:00', '2027-03-01T10:30:00+08:00']) {
      const q = query(dataDir, iso);
      if (!q?.pool) {
        problems.push(`no pool at ${iso}`);
        continue;
      }
      if (cents(q.pool.formatted['pool-consumed']) + cents(q.pool.formatted['pool-remaining']) !== q.pool.tuitionMinor) problems.push(`consumed + remaining != tuition at ${iso} in credit mode`);
    }
  });
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`mode switch and credits: ${ui.detail}; wizard credits validation: ${wizard.detail}; real server + query: duration price = hand-computed, credit price = 398,000 x 1/5 over the course's 14 x 3 h = hand-computed, different from each other, consumed + remaining == tuition at 4 instants (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P4b.5
const NOW_Y2 = '2027-10-11T10:30:00+08:00'; // Monday, MFIN7001 09:00-12:00 (2027 S1)
const OLD_ID = 'ft-thu-s1@fixture|2026-11-12T02:00:00Z';
const NEW_ID = 'nx-thu-s1@fixture|2027-10-14T02:00:00Z';

async function p4b5() {
  const core = requireVitest(/^tests\/core\/years\.test\.ts$/, [
    'now in the new year: the new year is current, the old year is an archive',
    'now in the old year: the old year is current and the new one is upcoming (not archived)',
    'the total equals the sum of the years, and equals the one-pass summary of everything',
  ]);
  if (!core.ok) return core;
  const ui = requireVitest(/^tests\/ui\/years\.test\.tsx$/, [
    'now in the new year: 2027 is current and 2026 is a read-only archive; marking an old class is refused, a new one works',
    'now in the old year: 2026 is current and the new year is upcoming',
    'archived classes have disabled mark buttons and a read-only note',
    'the main screen shows the current year only',
    'the history total equals the sum of the years and the all-years total from core',
    "keeps the old year's marks and slacking records, recognises only the new course, and builds the 2027 pool",
    'cancel deletes the calendar file this import added and changes nothing else',
    'lists every year with its role; the tuition of an archived year cannot be edited, the current one can',
  ]);
  if (!ui.ok) return ui;

  // data half: the old year's marks and slacking records are written, the new year's calendar is added through the API
  // (what the import does), and nothing of the old data moves; core (query) agrees on roles, focus year and the history.
  const dataDir = makeTempDir('tt-accept-p4b5-');
  const problems = [];
  const marksDoc = { schemaVersion: 1, marks: { [OLD_ID]: { status: 'skipped' }, [NEW_ID]: { status: 'cancelled' } } };
  const slacksDoc = { schemaVersion: 1, records: [{ id: 'r-old', sessionId: OLD_ID, startMs: Date.parse('2026-11-12T10:00:00+08:00'), endMs: Date.parse('2026-11-12T10:30:00+08:00') }] };
  await withServer(dataDir, async (port) => {
    if ((await postCalendar(port, fullTerm)).status !== 201) throw new Error('POST old calendar failed');
    if ((await putDoc(port, 'config', 0, makeConfig())).status !== 200) throw new Error('PUT config failed');
    if ((await putDoc(port, 'marks', 0, marksDoc)).status !== 200) throw new Error('PUT marks failed');
    if ((await putDoc(port, 'slacks', 0, slacksDoc)).status !== 200) throw new Error('PUT slacks failed');
    const before = (await httpRaw(port, { path: '/api/data' })).json;
    if ((await postCalendar(port, nextYear)).status !== 201) throw new Error('POST new-year calendar failed');
    const after = (await httpRaw(port, { path: '/api/data' })).json;
    if (after.calendars.length !== 2) problems.push(`${after.calendars.length} calendars after the import, expected 2`);
    if (JSON.stringify(after.marks) !== JSON.stringify(before.marks)) problems.push('the marks changed during the new-year import');
    if (JSON.stringify(after.slacks) !== JSON.stringify(before.slacks)) problems.push('the slacking records changed during the new-year import');
    if (JSON.stringify(after.config) !== JSON.stringify(before.config)) problems.push('the config changed during the calendar upload');
  });
  const y2 = query(dataDir, NOW_Y2);
  const y1 = query(dataDir, NOW_Y1);
  if (!y2 || !y1) return fail('query failed');
  const roles = (q) => q.years.map((y) => `${y.year}:${y.role}`).join(',');
  if (roles(y2) !== '2026:archived,2027:current') problems.push(`roles at the new-year instant: ${roles(y2)}`);
  if (roles(y1) !== '2026:current,2027:upcoming') problems.push(`roles at the old-year instant: ${roles(y1)}`);
  if (y2.focusYear !== 2027 || y1.focusYear !== 2026) problems.push(`focus years ${y2.focusYear} / ${y1.focusYear}`);
  if (y2.status !== 'in-class' || y2.pool?.key !== '2027-S1') problems.push(`new-year instant: status ${y2.status}, pool ${y2.pool?.key}`);
  if (y1.pool?.key !== '2026-S1') problems.push(`old-year instant: pool ${y1.pool?.key}`);
  if (y2.marks.skippedCount !== 1) problems.push(`the old year's skipped mark is not counted at the new-year instant (${y2.marks.skippedCount})`);
  const sum = y2.history.years.reduce((a, y) => a + y.costMinor, 0);
  if (sum !== y2.history.totalCostMinor) problems.push(`history total ${y2.history.totalCostMinor} != sum of the years ${sum}`);
  if (y2.history.years.length !== 2) problems.push(`${y2.history.years.length} years in the history`);
  if (cents(y2.pool?.formatted['pool-consumed'] ?? '0') + cents(y2.pool?.formatted['pool-remaining'] ?? '0') !== y2.pool?.tuitionMinor) problems.push('consumed + remaining != tuition in the new year');
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`core: ${core.detail}; pages: ${ui.detail}; real server + query: marks / slacks / config untouched by adding the new year's calendar; roles archived+current at the new-year instant and current+upcoming at the old one; focus year and tank follow the current year; the old skipped mark still counted; history total = sum of the years; consumed + remaining == tuition (browser half: see dev report)`);
}

export const checks = [
  { id: 'P4b.1', title: 'privacy mode: key B blurs every amount, not while typing, not saved', run: p4b1 },
  { id: 'P4b.2', title: 'theme: follow system / light / dark, saved in config, set before first paint', run: p4b2 },
  { id: 'P4b.3', title: 'second currency: small line = core convert, bad rates refused, date shown', run: p4b3 },
  { id: 'P4b.4', title: 'credit-weighted mode: credits validated, "unit price from X to Y", consumed + remaining = tuition', run: p4b4 },
  { id: 'P4b.5', title: 'several academic years: current / archive roles, read-only, history = sum of the years, marks kept', run: p4b5 },
];
