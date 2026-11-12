// P3c acceptance checks (session list, marks, settings). Standard numbers match .pipeline/PLAN.md: P3c.1 ... P3c.5.
// P3c.6 (visual) is not automated. P3c.2 / P3c.4 automate their data halves with the real server and `npm run query` /
// `npm run inspect` as independent sources; P3c.5 automates the clock half (`window.__tt_debug.ticks` and the
// throttling) with fake timers - the real-browser half is in the dev report.
//
// Privacy: P3c.4 may run over test-data/private (the user's real calendar). Only PASS / FAIL and aggregate counts are
// ever printed; no titles, codes, places, dates or times.

import fs from 'node:fs';
import path from 'node:path';
import { root, findFreeBase, httpRaw, makeTempDir, ok, fail, putDoc, requireVitest, runShell, startLocalServer } from './lib.mjs';

const fixture = path.join(root, 'tests', 'fixtures', 'full-term.ics');
const tsx = (script, args) => runShell(`npx tsx ${script} ${args.map((a) => `"${a}"`).join(' ')}`);
const cents = (text) => Math.round(Number(String(text).replace(/,/g, '')) * 100);
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

// ------------------------------------------------------------------ P3c.1
async function p3c1() {
  const state = requireVitest(/^tests\/state\/marks\.test\.ts$/, [
    'PUTs marks.json keyed by session id (UID|original start UTC) with the status',
    'clears a mark again and leaves nothing behind',
    'marking changes no unit price and consumed + remaining stays equal to the tuition at random instants',
    'skipped-loss and swallowed-tuition equal core',
  ]);
  if (!state.ok) return state;
  const page = requireVitest(/^tests\/ui\/sessions\.test\.tsx$/, [
    'marks a class as skipped and another as cancelled: PUT marks, tags with glyph and text, summary from core',
    'the dashboard follows a mark: a cancelled class is not "in class"',
  ]);
  if (!page.ok) return page;
  const model = requireVitest(/^tests\/state\/sessions\.test\.ts$/, [
    'counts only classes that have ended',
    "the three figures are core's numbers, formatted",
    'marks do not change the cost column',
  ]);
  if (!model.ok) return model;
  return ok(`marks state: ${state.detail}; page: ${page.detail}; session model: ${model.detail}`);
}

// ------------------------------------------------------------------ P3c.2 (data half)
const MON_ID = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';
const THU_ID = 'ft-thu-s1@fixture|2026-11-12T02:00:00Z';

async function p3c2() {
  const dataDir = makeTempDir('tt-accept-p3c-');
  const make = tsx('scripts/acceptance/p3b-make-config.ts', [fixture, 'cal-fixture']);
  if (make.status !== 0) return fail(`could not build the wizard config: ${make.output.trim().slice(-200)}`);
  const config = lastJson(make.stdout);

  // 1. through the real server: setup, then the marks a user would make in the session list
  const port = await findFreeBase(2, 4480);
  let srv = startLocalServer(['--no-open', '--port', String(port), '--data-dir', dataDir]);
  try {
    await srv.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/);
    if ((await putDoc(port, 'config', 0, config)).status !== 200) return fail('PUT config failed');
    const post = await httpRaw(port, { method: 'POST', path: '/api/calendars', headers: { 'X-Tuition-Ticker': '1', 'Content-Type': 'text/calendar' }, body: fs.readFileSync(fixture, 'utf8') });
    if (post.status !== 201) return fail(`POST /api/calendars -> ${post.status}`);
    const marksDoc = { schemaVersion: 1, marks: { [MON_ID]: { status: 'skipped' }, [THU_ID]: { status: 'cancelled' } } };
    const put = await putDoc(port, 'marks', 0, marksDoc);
    if (put.status !== 200) return fail(`PUT marks -> ${put.status}`);
  } finally {
    await srv.kill();
  }
  // 2. "refresh": a new server process over the same folder still has the marks
  const port2 = port + 1;
  srv = startLocalServer(['--no-open', '--port', String(port2), '--data-dir', dataDir]);
  try {
    await srv.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/);
    const data = await httpRaw(port2, { path: '/api/data' });
    const stored = data.json?.marks?.marks ?? {};
    if (stored[MON_ID]?.status !== 'skipped' || stored[THU_ID]?.status !== 'cancelled') return fail(`marks not persisted across a restart: ${JSON.stringify(Object.keys(stored))}`);
    if (!/^[^|]+\|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(MON_ID) || Object.keys(stored).some((k) => !/^[^|]+\|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(k))) return fail('a mark key is not of the form UID|original-start-UTC');
  } finally {
    await srv.kill();
  }

  // 3. the page's three figures (UI state layer) against `npm run query` (core only) at two instants
  const problems = [];
  let compared = 0;
  for (const iso of ['2026-12-01T00:00:00+08:00', '2027-05-10T10:00:00+08:00']) {
    const model = tsx('scripts/acceptance/p3c-model.ts', [dataDir, 'Asia/Hong_Kong', iso]);
    if (model.status !== 0) return fail(`page-model script failed: ${model.output.trim().slice(-300)}`);
    const page = lastJson(model.stdout);
    const q = runShell(`npm run query --silent -- --now "${iso}" --data-dir "${dataDir}" --tz Asia/Hong_Kong`);
    if (q.status !== 0) return fail(`query exited ${q.status}: ${q.output.trim().slice(-200)}`);
    const query = JSON.parse(q.stdout);
    for (const [name, value] of Object.entries(page.summary)) {
      compared++;
      if (query.marks.formatted[name] !== value) problems.push(`${iso}: ${name} page "${value}" vs query "${query.marks.formatted[name]}"`);
    }
    if (query.marks.skippedCount !== 1 || query.marks.cancelledCount !== 1) problems.push(`${iso}: query counts ${query.marks.skippedCount} skipped / ${query.marks.cancelledCount} cancelled, expected 1 / 1`);
    if (query.marks.skippedMinor <= 0 || query.marks.cancelledMinor <= 0) problems.push(`${iso}: the lost / swallowed amounts are not positive`);
    if (query.pool && cents(query.pool.formatted['pool-consumed']) + cents(query.pool.formatted['pool-remaining']) !== query.pool.tuitionMinor) problems.push(`${iso}: tank consumed + remaining != tuition`);
    if (query.totals.consumedMinor + query.totals.remainingMinor !== query.totals.tuitionMinor) problems.push(`${iso}: totals consumed + remaining != tuition`);
  }
  // a cancelled class is not "in class", and marking changed no price: the in-class unit price is still the pool's
  const during = runShell(`npm run query --silent -- --now "2026-11-12T10:30:00+08:00" --data-dir "${dataDir}" --tz Asia/Hong_Kong`);
  const duringJson = during.status === 0 ? JSON.parse(during.stdout) : null;
  if (!duringJson) problems.push(`query during the cancelled class exited ${during.status}`);
  else if (duringJson.status === 'in-class') problems.push('a class marked cancelled still counts as "in class"');
  const mondayJson = (() => {
    const r = runShell(`npm run query --silent -- --now "2026-11-16T10:30:00+08:00" --data-dir "${dataDir}" --tz Asia/Hong_Kong`);
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  })();
  if (!mondayJson?.session || mondayJson.session.formatted['rate-per-sec'] !== 'HK$1.2708') problems.push('the unit price changed after marking');
  if (problems.length) return fail(problems.slice(0, 5).join('; '));
  return ok(`marks written through POST/PUT on the real server, still there after a server restart (keys UID|original-start); page figures vs query at 2 instants: ${compared} figures identical; a cancelled class is not in-class; unit price unchanged; consumed + remaining == tuition (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P3c.3
async function p3c3() {
  const state = requireVitest(/^tests\/state\/settings\.test\.ts$/, [
    'changing the tuition opens the dialog with the old and new unit price from core, and sends nothing until confirmed',
    "changing the second semester does not change the first semester's unit price",
    'shows "not set" for that semester only, and its figures are zero',
    'editing one semester writes only that semester into byPool',
  ]);
  if (!state.ok) return state;
  const page = requireVitest(/^tests\/ui\/settings\.test\.tsx$/, [
    'changing the tuition: the dialog says "unit price will change from X to Y" with core',
    'a semester without tuition says "未设置学费" and the other semester is not affected',
    're-importing a calendar from the page replaces it and reports the marks that were kept',
  ]);
  if (!page.ok) return page;
  const re = requireVitest(/^tests\/state\/reimport\.test\.ts$/, [
    'marks stay attached by session id; a class the school moved keeps its mark under the original-start id',
    'an identical file changes nothing',
    'when the upload fails the old calendar stays',
  ]);
  if (!re.ok) return re;
  return ok(`settings state: ${state.detail}; settings page: ${page.detail}; re-import: ${re.detail}`);
}

// ------------------------------------------------------------------ P3c.4 (data half)
function checkSource(label, source, rateFragmentLength = 4) {
  const outDir = makeTempDir('tt-accept-p3c-e2e-');
  const built = tsx('scripts/acceptance/p3c-e2e.ts', [source, outDir, 'Asia/Hong_Kong']);
  if (built.status !== 0) return { ok: false, detail: `${label}: could not run the wizard preview: ${built.output.trim().slice(-200)}` };
  const preview = lastJson(built.stdout);

  const isDir = fs.statSync(source).isDirectory();
  const ins = runShell(`npm run inspect --silent -- ${isDir ? '--dir' : '--file'} "${source}" --tuition 398000 --json --redact`);
  if (!ins.stdout.trim().startsWith('{')) return { ok: false, detail: `${label}: inspect failed (exit ${ins.status})` };
  const inspect = JSON.parse(ins.stdout);

  const problems = [];
  if (preview.sessionCount !== inspect.billableSessions) problems.push(`${label}: preview ${preview.sessionCount} sessions vs inspect ${inspect.billableSessions}`);
  const inspectHours = inspect.pools.reduce((sum, p) => sum + p.totalHours * 3600, 0);
  if (Math.abs(Number(preview.hours) - inspectHours / 3600) > 0.15 * inspect.pools.length) problems.push(`${label}: preview ${preview.hours} h vs inspect ${(inspectHours / 3600).toFixed(1)} h`);
  if (preview.pools.length !== inspect.pools.length) problems.push(`${label}: preview ${preview.pools.length} pools vs inspect ${inspect.pools.length}`);
  preview.pools.forEach((p, i) => {
    const ip = inspect.pools[i];
    if (!ip) return;
    if (p.sessions !== ip.sessions) problems.push(`${label}: pool ${i + 1}: ${p.sessions} vs ${ip.sessions} sessions`);
    if (p.rate !== `HK$${ip.ratePerSecondMajor.toFixed(rateFragmentLength)}`) problems.push(`${label}: pool ${i + 1}: rate ${p.rate} vs inspect HK$${ip.ratePerSecondMajor.toFixed(rateFragmentLength)}`);
  });

  // the dashboard's in-class numbers (UI state layer) against `npm run query`, at a moment inside a class
  const model = tsx('scripts/acceptance/p3b-model.ts', [outDir, 'Asia/Hong_Kong', preview.inClassIso]);
  if (model.status !== 0) return { ok: false, detail: `${label}: page-model script failed: ${model.output.trim().slice(-200)}` };
  const row = lastJson(model.stdout)[0];
  const q = runShell(`npm run query --silent -- --now "${preview.inClassIso}" --data-dir "${outDir}" --tz Asia/Hong_Kong`);
  if (q.status !== 0) return { ok: false, detail: `${label}: query exited ${q.status}` };
  const query = JSON.parse(q.stdout);
  if (row.status !== 'in-class' || query.status !== 'in-class') problems.push(`${label}: the chosen instant is not in a class (page ${row.status}, query ${query.status})`);
  const source2 = { ...(query.pool?.formatted ?? {}), ...(query.session?.formatted ?? {}) };
  let compared = 0;
  for (const [name, value] of Object.entries(row.fields)) {
    compared++;
    if (source2[name] !== value) problems.push(`${label}: ${name} differs between the page model and query`);
  }
  if (problems.length) return { ok: false, detail: problems.slice(0, 4).join('; ') };
  return { ok: true, detail: `${label}: ${preview.sessionCount} sessions, ${preview.hours} h, ${preview.pools.length} pool(s), unit prices equal inspect; ${compared} in-class fields equal query` };
}

async function p3c4() {
  const parts = [];
  const fixtureResult = checkSource('fixture', fixture);
  if (!fixtureResult.ok) return fail(fixtureResult.detail);
  parts.push(fixtureResult.detail);

  const privateDir = process.env.TT_PRIVATE_DIR ? path.resolve(process.env.TT_PRIVATE_DIR) : path.join(root, 'test-data', 'private');
  const hasPrivate = fs.existsSync(privateDir) && fs.readdirSync(privateDir).some((f) => /\.(zip|ics)$/i.test(f));
  if (!hasPrivate) {
    parts.push('real calendar: skipped (test-data/private has no calendar)');
  } else {
    const real = checkSource('real calendar', privateDir);
    if (!real.ok) return fail(real.detail);
    parts.push(real.detail);
  }
  return ok(`${parts.join('; ')} (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P3c.5 (clock half)
async function p3c5() {
  const dbg = requireVitest(/^tests\/state\/debug\.test\.ts$/, [
    'exposes the clock update count, now, frozen and the offset',
    'in the background at most 12 updates in 10 seconds, in the foreground far more; the page is right the moment it is shown again',
  ]);
  if (!dbg.ok) return dbg;
  const clock = requireVitest(/^tests\/state\/clock\.test\.ts$/, [
    'updates at most once per second while hidden',
    'updates immediately when the page becomes visible again, then resumes per-frame updates',
  ]);
  if (!clock.ok) return clock;
  return ok(`${dbg.detail}; ${clock.detail} (real browser background tab: see dev report)`);
}

export const checks = [
  { id: 'P3c.1', title: 'marks keep the invariants (PUT key = session id, consumed + remaining == tuition, summary = core)', run: p3c1 },
  { id: 'P3c.2', title: 'marks persist and the page figures = query (data half, real server)', run: p3c2 },
  { id: 'P3c.3', title: 'settings: unit-price preview, per-semester tuition, re-import keeps marks, unset tuition', run: p3c3 },
  { id: 'P3c.4', title: 'end to end: wizard preview = inspect, dashboard = query (fixture and, if present, the real calendar)', run: p3c4 },
  { id: 'P3c.5', title: 'background throttling: __tt_debug.ticks <= 12 / 10 s hidden, right time on return (fake timers)', run: p3c5 },
];
