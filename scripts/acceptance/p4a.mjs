// P4a acceptance checks (subscription sync, statistics, share card, skip calculator, reminders).
// Standard numbers match .pipeline/PLAN.md: P4a.1 ... P4a.6; P4a.7 is an extra check for an upstream request (pending
// edits are flushed when the page is hidden). P4a.5 (visual) is not automated. P4a.2 automates its data half with the
// real server and the local subscription source (tests/helpers/ics-server.mjs, started as the testers will start it);
// P4a.4 / P4a.6 automate what runs without a browser (drawing, notification calls with a stub) - the real-browser halves
// are in the dev report.
//
// Subscription links are private: only the local ics-server is ever used here, and no link is printed.

import fs from 'node:fs';
import path from 'node:path';
import { root, findFreeBase, httpRaw, makeTempDir, ok, fail, putDoc, requireVitest, runShell, spawnProc, startLocalServer, runCmd } from './lib.mjs';

const fixture = path.join(root, 'tests', 'fixtures', 'full-term.ics');
const tsx = (script, args) => runShell(`npx tsx ${script} ${args.map((a) => `"${a}"`).join(' ')}`);
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));
const WRITE = { 'X-Tuition-Ticker': '1' };

// ------------------------------------------------------------------ P4a.1
async function p4a1() {
  const r = runCmd(process.execPath, ['--test', '--test-reporter=spec', 'tests/server/calendar-sync.test.js'], { timeoutMs: 120000 });
  if (r.status !== 0) return fail(`calendar-sync.test.js failed (exit ${r.status}): ${r.output.trim().slice(-300)}`);
  const passed = r.output.split('\n').filter((l) => /^\s*[✔✓]/.test(l)).join('\n');
  const required = [
    'accepts http and https (and webcal, which is https), rejects file://, ftp:// and things that are not links',
    'downloads over http from a local source and over https through an injected fetch',
    'refuses an answer larger than 5 MB',
    'refuses an answer that does not start with BEGIN:VCALENDAR',
    'refuses when the source is too slow (timeout)',
    'refuses a non-2xx answer and an unreachable source',
    'stores the calendar, keeps the old file when a sync fails, and never leaks the link',
    'syncs once when started and then whenever the injected timer fires',
    'POST /api/subscriptions downloads the link, answers without it',
    'synchronises once when the server starts',
  ];
  const missing = required.filter((n) => !passed.includes(n));
  if (missing.length) return fail(`required node:test case(s) not passing: ${missing.join(' | ')}`);
  const arch = runShell('npm run check:arch');
  if (arch.status !== 0) return fail(`check:arch failed: ${arch.output.trim().slice(-200)}`);
  if (!/zero third-party imports: yes/.test(arch.output)) return fail('check:arch does not confirm zero third-party imports in server/');
  return ok(`${required.length} required server cases pass (http / https accepted; file:// ftp:// non-URL refused; > 5 MB, non-calendar, timeout, HTTP error refused; old ics kept on failure; link absent from errors, logs and API; injected timer fires once; sync at start); check:arch: server/ has zero third-party imports`);
}

// ------------------------------------------------------------------ P4a.2 (data half)
const MON_MOVED = 'ft-mon-s1@fixture|2026-11-16T01:00:00Z'; // the Monday class that full-term-changed.ics moves to 14:00
const NOW = '2026-11-12T10:30:00+08:00';
const LATER = '2027-05-10T10:00:00+08:00';
const cents = (text) => Math.round(Number(String(text).replace(/,/g, '')) * 100);

async function p4a2() {
  const dataDir = makeTempDir('tt-accept-p4a-');
  const ports = await findFreeBase(2, 4620);
  // the local subscription source, started the way the testers start it
  const src = spawnProc(process.execPath, [path.join(root, 'tests', 'helpers', 'ics-server.mjs'), '--port', String(ports), '--file', fixture]);
  const server = startLocalServer(['--no-open', '--port', String(ports + 1), '--data-dir', dataDir]);
  const problems = [];
  try {
    const linkLine = await src.waitForLine(/ICS_SERVER_URL=(http:\/\/127\.0\.0\.1:\d+\/calendar\.ics)/);
    const link = linkLine[1];
    await server.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/);
    const port = ports + 1;
    const api = (opts) => httpRaw(port, { headers: { ...WRITE, 'Content-Type': 'application/json' }, ...opts });

    // 1. first sync: the calendar appears and has a "last synced" time
    const before = Date.now();
    const added = await api({ method: 'POST', path: '/api/subscriptions', body: JSON.stringify({ url: link }) });
    if (added.status !== 201) return fail(`POST /api/subscriptions -> ${added.status} ${added.text.slice(0, 120)}`);
    const subId = added.json.calendarId;
    if (added.text.includes(link) || added.text.includes('127.0.0.1')) problems.push('the subscribe response contains the link');
    const data1 = await httpRaw(port, { path: '/api/data' });
    if (data1.json.calendars.length !== 1 || !data1.json.calendars[0].text.includes('BEGIN:VCALENDAR')) problems.push('the subscribed calendar is not in /api/data');
    const info = data1.json.subscriptions?.[0];
    if (!info || info.calendarId !== subId || !(info.lastSyncMs >= before - 1000 && info.lastSyncMs <= Date.now() + 1000)) problems.push('no sensible "last synced" time after the first sync');
    if (data1.text.includes(link) || data1.text.includes(String(ports))) problems.push('/api/data exposes the link');

    // 2. setup like the wizard would leave it, plus marks: one on the class the change will move, one cancelled
    const make = tsx('scripts/acceptance/p3b-make-config.ts', [fixture, subId]);
    if (make.status !== 0) return fail(`could not build the wizard config: ${make.output.trim().slice(-200)}`);
    if ((await putDoc(port, 'config', 0, lastJson(make.stdout))).status !== 200) return fail('PUT config failed');
    const marks = { schemaVersion: 1, marks: { [MON_MOVED]: { status: 'skipped' }, 'ft-thu-s1@fixture|2026-11-05T02:00:00Z': { status: 'cancelled' } } };
    if ((await putDoc(port, 'marks', 0, marks)).status !== 200) return fail('PUT marks failed');

    const query = (iso) => {
      const q = runShell(`npm run query --silent -- --now "${iso}" --data-dir "${dataDir}" --tz Asia/Hong_Kong`);
      return q.status === 0 ? JSON.parse(q.stdout) : null;
    };
    const pageRate = () => {
      const m = tsx('scripts/acceptance/p3b-model.ts', [dataDir, 'Asia/Hong_Kong', NOW]);
      return m.status === 0 ? lastJson(m.stdout)[0].fields['rate-per-sec'] : null;
    };
    const q0 = query(NOW);
    const q0later = query(LATER);
    if (!q0?.session || !q0later) return fail('query failed before the change');
    const oldRate = q0.session.formatted['rate-per-sec'];
    if (oldRate !== 'HK$1.2708') problems.push(`old unit price ${oldRate}, expected HK$1.2708`);
    if (pageRate() !== oldRate) problems.push('page model and query disagree on the old unit price');

    // 3. the source changes one class (moved) and drops another; sync again
    const textBefore = data1.json.calendars[0].text;
    const sw = await httpRaw(port - 1, { path: '/__fixture?name=full-term-changed.ics' });
    if (sw.status !== 200) return fail('ics-server did not switch the fixture');
    const sync = await api({ method: 'POST', path: `/api/calendars/${subId}/sync` });
    if (sync.status !== 200 || sync.json.changed !== true) return fail(`sync -> ${sync.status} changed=${sync.json?.changed}`);
    const q1 = query(NOW);
    const q1later = query(LATER);
    if (!q1?.session || !q1later) return fail('query failed after the sync');
    const newRate = q1.session.formatted['rate-per-sec'];
    if (newRate === oldRate) problems.push('the unit price did not change although a class was dropped');
    // hand computation: 398,000.00 over 28 classes of 3 hours (one Thursday was dropped from 29)
    const expected = `HK$${(398000 / (28 * 3 * 3600)).toFixed(4)}`;
    if (newRate !== expected) problems.push(`new unit price ${newRate}, hand-computed ${expected}`);
    if (pageRate() !== newRate) problems.push('page model and query disagree on the new unit price');
    if (cents(q1.pool.formatted['pool-consumed']) + cents(q1.pool.formatted['pool-remaining']) !== q1.pool.tuitionMinor) problems.push('tank consumed + remaining != tuition after the sync');
    // marks survive: same keys in the document, same counts in the summary (the moved class keeps its original-start id)
    const data2 = await httpRaw(port, { path: '/api/data' });
    if (data2.json.marks.marks?.[MON_MOVED]?.status !== 'skipped') problems.push('the mark on the moved class was lost');
    if (q0later.marks.skippedCount !== 1 || q1later.marks.skippedCount !== 1) problems.push(`skipped count before/after: ${q0later.marks.skippedCount}/${q1later.marks.skippedCount}, expected 1/1`);
    if (q1later.marks.cancelledCount !== 1) problems.push('the cancelled mark is not counted after the sync');
    const unchanged = await api({ method: 'POST', path: `/api/calendars/${subId}/sync` });
    if (unchanged.json?.changed !== false) problems.push('syncing an unchanged source should report changed=false');

    // 4. the source goes away: an error, the data stays exactly as it was
    const stored = data2.json.calendars[0].text;
    if (stored === textBefore) problems.push('the stored calendar did not change with the source');
    await src.kill();
    const failed = await api({ method: 'POST', path: `/api/calendars/${subId}/sync` });
    if (failed.status !== 502 || failed.json?.error !== 'network') problems.push(`sync with the source down -> ${failed.status} ${failed.json?.error}`);
    if (failed.text.includes(link) || failed.text.includes(String(ports))) problems.push('the failure answer contains the link');
    const data3 = await httpRaw(port, { path: '/api/data' });
    if (data3.json.calendars[0].text !== stored) problems.push('the calendar changed although the sync failed');
    if (data3.json.subscriptions[0].lastError !== 'network') problems.push('the failed sync was not recorded');
    if (JSON.stringify(data3.json.marks.marks) !== JSON.stringify(data2.json.marks.marks)) problems.push('the marks changed although the sync failed');
  } finally {
    await server.kill();
    await src.kill();
  }
  if (problems.length) return fail(problems.slice(0, 5).join('; '));
  const page = requireVitest(/^tests\/state\/subscriptions\.test\.ts$/, [
    'adding a link: the server downloads it',
    'unit price changed from X to Y',
    'a source that is down: an error report, the calendar and the data stay as they were',
  ]);
  if (!page.ok) return page;
  const ui = requireVitest(/^tests\/ui\/p4a\.test\.tsx$/, ['adds a link, lists the subscription with "last synced", syncs on demand and reports a price change']);
  if (!ui.ok) return ui;
  return ok(`real server + ics-server: first sync shows the calendar with a "last synced" time; after the source dropped a class and moved another the unit price went HK$1.2708 -> hand-computed new price (page model = query both times); the mark on the moved class kept; consumed + remaining == tuition; source down -> 502 'network', calendar / marks untouched, error recorded; link absent from every answer; page state: ${page.detail}; page: ${ui.detail} (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P4a.3
async function p4a3() {
  const core = requireVitest(/^tests\/core\/stats\.test\.ts$/, [
    'ranks courses by money, with cost per hour, attendance and slacking (hand-computed)',
    'finds the most expensive session (earliest wins a tie) and the one with the most slacking',
    'slacking: total, rate, favourite course, longest single slack',
    'HK$3,980 against the HK$45 box of three-dish rice is 88 boxes (core numbers)',
    'returns the "before" reminder from N minutes before the start until the start, and the "end" reminder at the end',
    'never returns a reminder that has been fired already, so each of the two comes exactly once',
    'the end reminder carries the class cost and the slack minutes and money',
  ]);
  if (!core.ok) return core;
  const page = requireVitest(/^tests\/ui\/p4a\.test\.tsx$/, ['shows "throw away HK$x = n boxes of three-dish rice" from core', 'shows the course ranking, the slacking figures and the period summaries from core, drawn as SVG']);
  if (!page.ok) return page;
  const arch = runShell('npm run check:arch');
  if (arch.status !== 0) return fail(`check:arch failed: ${arch.output.trim().slice(-200)}`);
  return ok(`stats / notify / skip calculator: ${core.detail}; pages: ${page.detail}; check:arch still passes (src/core/stats.ts and notify.ts are pure)`);
}

// ------------------------------------------------------------------ P4a.4
async function p4a4() {
  const unit = requireVitest(/^tests\/state\/share\.test\.ts$/, [
    'is a 1080 x 1440 PNG',
    'draws money, slacking, an equivalent and attendance - and nothing that identifies the user (school name TESTSCHOOL)',
    'the data type has no identity field at all',
    'names the download file with the date and the .png extension',
  ]);
  if (!unit.ok) return unit;
  const page = requireVitest(/^tests\/ui\/p4a\.test\.tsx$/, ['"生成分享卡" makes a 1080 x 1440 PNG that can be saved as a .png file, without the school name']);
  if (!page.ok) return page;
  return ok(`share card: ${unit.detail}; page: ${page.detail} (the real PNG header from a real canvas: see dev report - window.__tt_debug.shareCard())`);
}

// ------------------------------------------------------------------ P4a.6
async function p4a6() {
  const v = requireVitest(/^tests\/ui\/p4a\.test\.tsx$/, [
    'granted: one notification N minutes before the class and one at the end (with the slack minutes and money), never repeated',
    'denied: the notification stub is never called, the reminder shows inside the page with a note',
    'the lead time can be changed in the settings and works at once',
    'off by default, switchable off again, silent for cancelled classes, and the first switch-on asks for permission',
  ]);
  if (!v.ok) return v;
  return ok(`${v.detail} (stub installed in a real browser page with ?now: see dev report)`);
}

// ------------------------------------------------------------------ P4a.7 (extra: upstream request)
async function p4a7() {
  return requireVitest(/^tests\/state\/leave\.test\.ts$/, [
    'pagehide sends the pending marks at once, with keepalive and the write header',
    'visibilitychange to hidden does the same',
    'nothing pending means no request; a failing request is silent',
  ]);
}

export const checks = [
  { id: 'P4a.1', title: 'subscription sync, server side (limits, refusals, old file kept, no link leaks, timers)', run: p4a1 },
  { id: 'P4a.2', title: 'subscription sync: first sync, price change = query, marks kept, source down (data half)', run: p4a2 },
  { id: 'P4a.3', title: 'statistics, skip calculator, reminders (core, hand-computed)', run: p4a3 },
  { id: 'P4a.4', title: 'share card: 1080x1440 PNG, no identity in the drawn texts, .png download', run: p4a4 },
  { id: 'P4a.6', title: 'reminders: stub called at N minutes before and at the end; denied -> in-page; lead time editable', run: p4a6 },
  { id: 'P4a.7', title: 'extra: pending edits are flushed (keepalive) when the page is hidden or closed', run: p4a7 },
];
