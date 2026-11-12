// P4c acceptance checks (manual classes, late / early, split-date check, backup, languages, copy intensity).
// Standard numbers match .pipeline/PLAN.md: P4c.1 ... P4c.6. Page-level checks run the Vitest suites (the whole <App />
// on a fake server in happy-dom); the data halves use the real server (started as the testers start it) and
// `npm run query` (core, independent of the UI state layer). Real-browser halves are in the dev report.

import fs from 'node:fs';
import path from 'node:path';
import { root, findFreeBase, httpRaw, makeTempDir, ok, fail, putDoc, requireVitest, runCmd, runShell, startLocalServer } from './lib.mjs';

const fullTerm = path.join(root, 'tests', 'fixtures', 'full-term.ics');
const lateTerm = path.join(root, 'tests', 'fixtures', 'late-term.ics');
const tsx = (script, args) => runShell(`npx tsx ${script} ${args.map((a) => `"${a}"`).join(' ')}`);
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));
const cents = (text) => Math.round(Number(String(text).replace(/,/g, '')) * 100);
const WRITE = { 'X-Tuition-Ticker': '1' };
const TZ = 'Asia/Hong_Kong';

const query = (dataDir, iso) => {
  const q = runShell(`npm run query --silent -- --now "${iso}" --data-dir "${dataDir}" --tz ${TZ}`);
  return q.status === 0 ? JSON.parse(q.stdout) : null;
};

async function withServer(dataDir, fn) {
  const port = await findFreeBase(1, 4660);
  const srv = startLocalServer(['--no-open', '--port', String(port), '--data-dir', dataDir]);
  try {
    await srv.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/);
    return await fn(port);
  } finally {
    await srv.kill();
  }
}

const postCalendar = (port, file) => httpRaw(port, { method: 'POST', path: '/api/calendars', headers: { ...WRITE, 'Content-Type': 'text/calendar' }, body: fs.readFileSync(file, 'utf8') });

function wizardConfig(file) {
  const r = tsx('scripts/acceptance/p3b-make-config.ts', [file, 'cal-a']);
  if (r.status !== 0) throw new Error(`could not build the wizard config: ${r.output.trim().slice(-200)}`);
  return lastJson(r.stdout);
}

// ------------------------------------------------------------------ P4c.1
async function p4c1() {
  const core = requireVitest(/^tests\/core\/manual\.test\.ts$/, [
    'every Tuesday 14:00-17:00 from 09-08 to 12-01 without 10-06 gives 12 classes at the hand-computed times',
    'they are manual classes: source "manual", ids start with "manual:"',
    'consumed + remaining equals the tuition at every instant for a mix of manual and other classes',
  ]);
  if (!core.ok) return core;
  const ui = requireVitest(/^tests\/ui\/p4c\.test\.tsx$/, [
    'a weekly course typed by hand: 12 Tuesday classes, and a "unit price from X to Y, recalculate?" question first (X, Y = core)',
    'cancelling the question writes nothing and adds nothing',
    'mixed with calendar classes, consumed + remaining equals the tuition at every instant',
    'a one-off make-up class can be added to an existing course and deleted again, each time asking about the price',
    'classes of an archived academic year cannot be added',
  ]);
  if (!ui.ok) return ui;
  const kept = requireVitest(/^tests\/ui\/b4-small-fixes\.test\.tsx$/, [
    'weekly form: cancel keeps every typed value; confirming adds the class and then empties the form',
    'one-off form: cancel keeps the date and times',
  ]);
  if (!kept.ok) return kept;

  // data half: a manual weekly course written the way the app writes it; core (query) bills it
  const dataDir = makeTempDir('tt-accept-p4c1-');
  const problems = [];
  const config = wizardConfig(fullTerm);
  config.courses.push({ id: 'c-m-seminar', code: null, name: 'Seminar', credits: null, color: '#3b6ea8', match: { codes: [], titles: ['seminar'] }, manual: true });
  const manual = { weekly: [{ id: 'w-1', courseId: 'c-m-seminar', title: 'Seminar', weekday: 2, start: '14:00', end: '17:00', fromDate: '2026-09-08', toDate: '2026-12-01', skipDates: ['2026-10-06'] }], singles: [] };
  await withServer(dataDir, async (port) => {
    if ((await postCalendar(port, fullTerm)).status !== 201) throw new Error('POST calendar failed');
    if ((await putDoc(port, 'config', 0, config)).status !== 200) throw new Error('PUT config failed');
    if ((await putDoc(port, 'marks', 0, { schemaVersion: 1, marks: {}, manual })).status !== 200) throw new Error('PUT marks failed');
  });
  // Tuesday 2026-11-10 15:00 HK is inside the manual class (14:00-17:00)
  const q = query(dataDir, '2026-11-10T15:00:00+08:00');
  if (!q?.session) return fail('query found no class in progress during the manual class');
  if (q.session.id !== 'manual:c-m-seminar|2026-11-10T06:00:00Z') problems.push(`session id ${q.session.id}`);
  // 29 calendar classes + 12 manual ones, all 3 hours, one pool 2026-S1: 398,000.00 / (41 x 10,800 s)
  const expectedRate = `HK$${(39_800_000 / 100 / (41 * 10_800)).toFixed(4)}`;
  if (q.session.formatted['rate-per-sec'] !== expectedRate) problems.push(`unit price ${q.session.formatted['rate-per-sec']}, hand ${expectedRate}`);
  if (q.session.index !== 9 || q.session.total !== 12) problems.push(`class ${q.session.index} of ${q.session.total}, expected 9 of 12 (10-06 skipped)`);
  for (const iso of ['2026-11-10T15:00:00+08:00', '2026-09-20T12:00:00+08:00', '2026-12-02T09:00:00+08:00', '2027-03-01T10:30:00+08:00']) {
    const p = query(dataDir, iso)?.pool;
    if (!p) problems.push(`no pool at ${iso}`);
    else if (cents(p.formatted['pool-consumed']) + cents(p.formatted['pool-remaining']) !== p.tuitionMinor) problems.push(`consumed + remaining != tuition at ${iso}`);
  }
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`core: ${core.detail}; pages: ${ui.detail}; the add-class form keeps what was typed after the price question is cancelled (${kept.detail}); real server + query: the 12 manual Tuesday classes are billed (class 9 of 12 on 11-10 because 10-06 is skipped), unit price ${expectedRate} = hand-computed 398,000.00 / (41 x 3 h), consumed + remaining == tuition at 4 instants (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P4c.2
async function p4c2() {
  const ui = requireVitest(/^tests\/ui\/p4c\.test\.tsx$/, [
    'minutes in [0, length] are saved; the loss is minutes x 60 x the unit price (= core), in the summary too; nothing else changes',
    'values outside [0, length], not whole numbers, or adding up to more than the class are refused with a reason and not saved',
    'a class marked as skipped has no late / early time',
  ]);
  if (!ui.ok) return ui;
  const core = requireVitest(/^tests\/core\/billing\.test\.ts$/, []);
  if (!core.ok) return core;

  const dataDir = makeTempDir('tt-accept-p4c2-');
  const problems = [];
  const MON = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';
  await withServer(dataDir, async (port) => {
    if ((await postCalendar(port, fullTerm)).status !== 201) throw new Error('POST calendar failed');
    if ((await putDoc(port, 'config', 0, wizardConfig(fullTerm))).status !== 200) throw new Error('PUT config failed');
    if ((await putDoc(port, 'marks', 0, { schemaVersion: 1, marks: { [MON]: { lateMin: 10, earlyMin: 20 } } })).status !== 200) throw new Error('PUT marks failed');
  });
  const q = query(dataDir, '2026-11-12T14:00:00+08:00');
  if (!q) return fail('query failed');
  // 29 classes x 3 h = 313,200 s for 398,000.00: 127.0753 minor per second; 10 min late = 600 s, 20 min early = 1200 s
  const perSec = 39_800_000 / 313_200;
  const late = Math.round(600 * perSec);
  const early = Math.round(1200 * perSec);
  if (q.marks.lateMinor !== late || q.marks.earlyMinor !== early) problems.push(`late / early loss ${q.marks.lateMinor} / ${q.marks.earlyMinor}, hand ${late} / ${early}`);
  if (q.marks.lateMinutes !== 10 || q.marks.earlyMinutes !== 20) problems.push(`minutes ${q.marks.lateMinutes} / ${q.marks.earlyMinutes}`);
  if (q.marks.lostMinor !== late + early) problems.push(`lost ${q.marks.lostMinor} != late + early`);
  if (q.marks.attendedCount !== q.marks.endedSessions) problems.push('late / early changed the attendance count');
  const rate = q.session?.formatted?.['rate-per-sec'] ?? q.prev?.formatted?.['rate-per-sec'];
  if (rate !== `HK$${(perSec / 100).toFixed(4)}`) problems.push(`unit price ${rate} changed`);
  if (cents(q.pool.formatted['pool-consumed']) + cents(q.pool.formatted['pool-remaining']) !== q.pool.tuitionMinor) problems.push('consumed + remaining != tuition');
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`page: ${ui.detail}; real data + query: 10 min late = ${late} and 20 min early = ${early} minor units (minutes x 60 x HK$1.2708 per second, hand-computed), the loss card figure ${q.marks.formatted['late-early-amount']}, attendance count and unit price unchanged, consumed + remaining == tuition`);
}

// ------------------------------------------------------------------ P4c.3
async function p4c3() {
  const ui = requireVitest(/^tests\/ui\/p4c\.test\.tsx$/, [
    'classes run past 12-25: the settings say where the winter break is and suggest a date; "adopt" sets it and recalculates',
    'adopting changes which semester a class belongs to (Dec 28 moves to the first semester) and the unit prices follow',
    'the split date is already inside the winter break: no suggestion, no button',
  ]);
  if (!ui.ok) return ui;
  const core = requireVitest(/^tests\/core\/academic\.test\.ts$/, ['suggest']);
  if (!core.ok) return core;

  // data half: with the suggested split date the class on 12-28 changes semester, according to core
  const dataDir = makeTempDir('tt-accept-p4c3-');
  const problems = [];
  const config = wizardConfig(lateTerm);
  await withServer(dataDir, async (port) => {
    if ((await postCalendar(port, lateTerm)).status !== 201) throw new Error('POST calendar failed');
    if ((await putDoc(port, 'config', 0, config)).status !== 200) throw new Error('PUT config failed');
  });
  const before = query(dataDir, '2026-12-28T10:00:00+08:00');
  if (before?.pool?.key !== '2026-S2') problems.push(`with split 12-25 the 12-28 class is in ${before?.pool?.key}, expected 2026-S2`);
  const adopted = { ...config, academic: { ...config.academic, splitDate: '01-07' } };
  await withServer(dataDir, async (port) => {
    const rev = (await httpRaw(port, { path: '/api/data' })).json.config.rev;
    if ((await putDoc(port, 'config', rev, adopted)).status !== 200) throw new Error('PUT adopted config failed');
  });
  const after = query(dataDir, '2026-12-28T10:00:00+08:00');
  if (after?.pool?.key !== '2026-S1') problems.push(`with split 01-07 the 12-28 class is in ${after?.pool?.key}, expected 2026-S1`);
  // 17 classes of 3 h in 2026-S1 now: 398,000.00 / (17 x 10,800 s)
  const expected = `HK$${(39_800_000 / 100 / (17 * 10_800)).toFixed(4)}`;
  if (after?.session?.formatted?.['rate-per-sec'] !== expected) problems.push(`unit price ${after?.session?.formatted?.['rate-per-sec']}, hand ${expected}`);
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`page: ${ui.detail}; academic: ${core.detail}; core (query) with the adopted split date 01-07: the 12-28 class moves from 2026-S2 to 2026-S1 and its unit price is ${expected} = hand-computed 398,000.00 / (17 x 3 h) (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P4c.4
async function p4c4() {
  const r = runCmd(process.execPath, ['--test', '--test-reporter=spec', 'tests/server/backup.test.js', 'tests/server/backup-fields.test.js'], { timeoutMs: 120000 });
  if (r.status !== 0) return fail(`backup.test.js / backup-fields.test.js failed (exit ${r.status}): ${r.output.trim().slice(-300)}`);
  const passed = r.output.split('\n').filter((l) => /^\s*[✔✓]/.test(l)).join('\n');
  const required = [
    'returns one JSON file with schemaVersion, config, marks, slacks and the calendar text, as a download',
    'never contains a subscription link, even when a calendar is fed by one',
    'export -> change things -> import restores them exactly, and the data before the import is backed up first',
    'refuses invalid files with 400 and changes nothing (no backup either)',
    'refuses a request without the X-Tuition-Ticker header',
    'accepts a backup larger than 5 MB (the import limit is 20 MB) and refuses one over 20 MB',
    // B4 fix: field-level checks
    'a file this program exported with real-shaped data (credits, second currency, several years, manual classes, late / early, language, intensity) imports again and the data is identical',
    'refuses wrongly typed fields with 400 naming the field (not echoing the value), changes nothing and leaves no backup',
    'tolerates fields it does not know (a later version may add some) and keeps them; bare documents are fine too',
  ];
  const missing = required.filter((n) => !passed.includes(n));
  if (missing.length) return fail(`required node:test case(s) not passing: ${missing.join(' | ')}`);
  const ui = requireVitest(/^tests\/ui\/p4c\.test\.tsx$/, [
    'export -> change the tuition -> import brings the tuition back',
    "refuses files that are not this program's backup",
  ]);
  if (!ui.ok) return ui;
  const real = requireVitest(/^tests\/ui\/b4-backup-roundtrip\.test\.tsx$/, [
    'every setting and every kind of record the app writes passes the import check',
  ]);
  if (!real.ok) return real;

  // real server process: export, change the tuition, import the export, tuition is back; invalid file -> 400, nothing changes
  const dataDir = makeTempDir('tt-accept-p4c4-');
  const problems = [];
  await withServer(dataDir, async (port) => {
    await postCalendar(port, fullTerm);
    const cfg = wizardConfig(fullTerm);
    await putDoc(port, 'config', 0, cfg);
    const exported = await httpRaw(port, { path: '/api/export' });
    if (exported.status !== 200 || exported.json?.schemaVersion !== 1) problems.push(`export -> ${exported.status}`);
    for (const key of ['config', 'marks', 'slacks', 'calendars']) if (!(key in (exported.json ?? {}))) problems.push(`export has no ${key}`);
    await putDoc(port, 'config', 1, { ...cfg, tuition: { defaultMinor: 100, byPool: {} } });
    const bad = await httpRaw(port, { method: 'POST', path: '/api/import', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...exported.json, schemaVersion: 2 }) });
    if (bad.status !== 400) problems.push(`wrong schemaVersion -> ${bad.status}`);
    const noHeader = await httpRaw(port, { method: 'POST', path: '/api/import', headers: { 'Content-Type': 'application/json' }, body: exported.text });
    if (noHeader.status !== 403) problems.push(`no header -> ${noHeader.status}`);
    if ((await httpRaw(port, { path: '/api/data' })).json.config.tuition.defaultMinor !== 100) problems.push('a refused import changed the data');
    const good = await httpRaw(port, { method: 'POST', path: '/api/import', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: exported.text });
    if (good.status !== 200) problems.push(`import -> ${good.status} ${good.text.slice(0, 80)}`);
    const data = (await httpRaw(port, { path: '/api/data' })).json;
    if (data.config.tuition.defaultMinor !== cfg.tuition.defaultMinor) problems.push('the tuition did not come back');
    // the safety copy of this first import holds the data as it was before it (checked here, before later imports add more copies)
    const dir = path.join(dataDir, 'backups');
    const copies = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('_before-import.json')).sort() : [];
    if (copies.length !== 1) problems.push(`${copies.length} before-import backups in data/backups, expected 1`);
    else if (JSON.parse(fs.readFileSync(path.join(dir, copies[0]), 'utf8')).config?.tuition?.defaultMinor !== 100) problems.push('the safety copy does not hold the data as it was before the import');

    // B4 fix: a wrongly typed field is refused with 400 (naming the field), and nothing changes
    const importText = (body) => httpRaw(port, { method: 'POST', path: '/api/import', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const dataBefore = (await httpRaw(port, { path: '/api/data' })).text;
    const copyCount = () => fs.readdirSync(dir).filter((f) => f.endsWith('_before-import.json')).length;
    const copiesBefore = copyCount();
    const ex = exported.json;
    const typeBad = [
      ['config.tuition.defaultMinor', { ...ex, config: { ...ex.config, tuition: { defaultMinor: 'abc' } } }],
      ['config.currency', { ...ex, config: { ...ex.config, currency: 'XXX' } }],
      ['config.academic.billingPeriod', { ...ex, config: { ...ex.config, academic: { ...ex.config.academic, billingPeriod: 'month' } } }],
      ['marks.marks', { ...ex, marks: { schemaVersion: 1, marks: { x: { lateMin: 'ten' } } } }],
      ['slacks.records[0].startMs', { ...ex, slacks: { schemaVersion: 1, records: [{ id: 'r', sessionId: 's', startMs: 'now' }] } }],
    ];
    for (const [field, body] of typeBad) {
      const r = await importText(body);
      if (r.status !== 400 || !String(r.json?.message ?? '').includes(field)) problems.push(`type-invalid ${field} -> ${r.status} ${r.text.slice(0, 80)}`);
      if (r.text.includes('abc') || r.text.includes('"ten"')) problems.push(`the 400 for ${field} echoes the data`);
    }
    if ((await httpRaw(port, { path: '/api/data' })).text !== dataBefore) problems.push('a type-invalid import changed the data');
    if (copyCount() !== copiesBefore) problems.push('a type-invalid import left a safety copy behind');

    // B4 fix: real-shaped data (credits, second currency, manual classes, late / early, language, intensity, theme) exports and imports back identically
    const rich = { ...cfg, billingMode: 'credit', secondaryCurrency: 'CNY', rates: { CNY: 0.14 }, language: 'en', intensity: 'extreme', theme: 'dark', reminders: { enabled: true, leadMinutes: 10 }, courses: cfg.courses.map((c, i) => (i === 0 ? { ...c, credits: 4 } : c)) };
    const cur = (await httpRaw(port, { path: '/api/data' })).json;
    await putDoc(port, 'config', cur.config.rev, rich);
    await putDoc(port, 'marks', cur.marks.rev, { schemaVersion: 1, marks: { 'a|2026-11-09T01:00:00Z': { lateMin: 10, earlyMin: 20 }, 'b|2026-11-10T01:00:00Z': { status: 'skipped' } }, manual: { weekly: [{ id: 'w-1', courseId: 'c-m-x', title: 'X', weekday: 2, start: '14:00', end: '17:00', fromDate: '2026-09-08', toDate: '2026-12-01', skipDates: [] }], singles: [] } });
    await putDoc(port, 'slacks', cur.slacks.rev, { schemaVersion: 1, records: [{ id: 'r1', sessionId: 'a|2026-11-09T01:00:00Z', startMs: 1788000000000, endMs: 1788000300000 }, { id: 'r2', sessionId: 'a|2026-11-09T01:00:00Z', startMs: 1788100000000 }] });
    const strip = (d) => JSON.stringify({ c: { ...d.config, rev: 0 }, m: { ...d.marks, rev: 0 }, s: { ...d.slacks, rev: 0 }, k: d.calendars });
    const richBefore = strip((await httpRaw(port, { path: '/api/data' })).json);
    const richExport = await httpRaw(port, { path: '/api/export' });
    await putDoc(port, 'config', (await httpRaw(port, { path: '/api/data' })).json.config.rev, { schemaVersion: 1 });
    const back = await importText(richExport.text);
    if (back.status !== 200) problems.push(`real-shaped export did not import: ${back.status} ${back.text.slice(0, 120)}`);
    else if (strip((await httpRaw(port, { path: '/api/data' })).json) !== richBefore) problems.push('real-shaped export -> import did not restore the data exactly');
  });
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`server: ${required.length} required cases pass (export holds config / marks / slacks / calendars / schemaVersion and no subscription link; export -> change -> import restores exactly; a safety copy is written before replacing; invalid files 400 and nothing changes; no header 403; 20 MB import limit; B4: wrongly typed fields (text for money, unknown currency / period, bad minutes / timestamps) give 400 naming the field, echo no data, change nothing and leave no safety copy; own exports with real-shaped data round-trip exactly and unknown extra fields are tolerated); page: ${ui.detail}; the documents the real app code writes pass the check: ${real.detail}; real server process: tuition 100 -> exported value restored, exactly 1 before-import copy in data/backups holding the changed data (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P4c.5
async function p4c5() {
  const chk = runShell('npm run check:i18n');
  if (chk.status !== 0) return fail(`check:i18n failed: ${chk.output.trim().slice(-300)}`);
  const counts = /zh-CN: (\d+) keys, zh-TW: (\d+) keys, en: (\d+) keys/.exec(chk.output);
  if (!counts || counts[1] !== counts[2] || counts[1] !== counts[3]) return fail('the three dictionaries do not have the same number of keys');
  const ui = runShell('npm run check:ui');
  if (ui.status !== 0) return fail(`check:ui failed (Chinese literal in src/ui or src/state?): ${ui.output.trim().slice(-200)}`);
  const v = requireVitest(/^tests\/ui\/p4c\.test\.tsx$/, [
    'the three dictionaries have exactly the same keys and placeholders, and the copy libraries are complete (check:i18n)',
    'the check notices a missing key, an extra key and a changed placeholder',
    'a key missing in a language falls back to zh-CN without an error',
    'switching to English and to Traditional Chinese changes the page text and <html lang> at once; the choice is saved and mirrored',
    'the saved language is used again after a reload (config -> locale and <html lang>)',
    'in English the /settings page (another state) shows no Chinese characters at all',
    'in English the / page (in class) shows no Chinese characters at all',
    'in English the /sessions page (another state) shows no Chinese characters at all',
  ]);
  if (!v.ok) return v;
  const wording = requireVitest(/^tests\/ui\/b4-small-fixes\.test\.tsx$/, [
    'zh-CN: no {minutes} / {count} touches a Chinese character',
    'zh-TW: no {minutes} / {count} touches a Chinese character',
    'the English copy lines name items as "{count} {item}" and never use "×"',
    'skip calculator, slacking hint, settlement card and copy variables read naturally in English',
  ]);
  if (!wording.ok) return wording;
  return ok(`B4 wording: the Chinese copy lines put a space between a number and the text (${wording.detail}), English says "304 boxes of three-dish rice"; check:i18n: ${counts[1]} keys in each of zh-CN / zh-TW / en, same placeholders, copy libraries complete; check:ui: no Chinese literal in src/ui and src/state; ${v.detail} (6 English pages audited for leftover Chinese)`);
}

// ------------------------------------------------------------------ P4c.6
async function p4c6() {
  const v = requireVitest(/^tests\/ui\/p4c\.test\.tsx$/, [
    "gentle: 50 draws in a row all come from that tier's lines and never repeat the previous one (every language)",
    "normal: 50 draws in a row all come from that tier's lines and never repeat the previous one (every language)",
    "extreme: 50 draws in a row all come from that tier's lines and never repeat the previous one (every language)",
    'the tiers are different sets of lines',
    'the settings offer the three tiers, save the choice in the config, and the lines on the home screen switch to the new tier at once',
  ]);
  if (!v.ok) return v;
  const copy = requireVitest(/^tests\/core\/copy\.test\.ts$/, []);
  if (!copy.ok) return copy;
  return ok(`${v.detail} (3 tiers x 3 languages x 50 draws; copy.test.ts still passes: ${copy.detail})`);
}

export const checks = [
  { id: 'P4c.1', title: 'manual classes: 12 Tuesday classes, price question X -> Y (= core), make-up add / delete, consumed + remaining = tuition', run: p4c1 },
  { id: 'P4c.2', title: 'late / early: [0, length] enforced, loss = minutes x price (= core), billing untouched', run: p4c2 },
  { id: 'P4c.3', title: 'split-date check: suggestion with gap dates, one-click adoption recalculates, no suggestion inside the break', run: p4c3 },
  { id: 'P4c.4', title: 'backup: export / import round trip, safety copy first, 400 on bad files and wrongly typed fields, header required, 20 MB limit', run: p4c4 },
  { id: 'P4c.5', title: 'languages: check:i18n (3 identical key sets), switch + <html lang> + reload, fallback, no Chinese literals in ui', run: p4c5 },
  { id: 'P4c.6', title: 'copy intensity: 50 draws from the chosen tier without repeats, saved in config, immediate effect', run: p4c6 },
];
