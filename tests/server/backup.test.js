import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withServer, putDoc } from './helpers.js';

let s;
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const ICS2 = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:second\r\nEND:VCALENDAR\r\n';

const stripRev = (doc) => {
  const { rev: _rev, ...rest } = doc;
  return rest;
};
const snapshot = async () => {
  const d = (await s.request({ path: '/api/data' })).json;
  return { config: stripRev(d.config), marks: stripRev(d.marks), slacks: stripRev(d.slacks), calendars: d.calendars };
};
const backupsOf = () => {
  const dir = path.join(s.dataDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('_before-import.json')).sort() : [];
};
const postImport = (body, extra = {}) => s.request({ method: 'POST', path: '/api/import', write: true, json: body, ...extra });

before(async () => {
  s = await withServer();
  const c = await s.request({ method: 'POST', path: '/api/calendars', write: true, headers: { 'Content-Type': 'text/calendar' }, body: ICS });
  assert.equal(c.status, 201);
  await putDoc(s.port, 'config', 0, { schemaVersion: 1, tuition: { defaultMinor: 39800000 }, currency: 'HKD' });
  await putDoc(s.port, 'marks', 0, { schemaVersion: 1, marks: { 'a|2026-11-12T02:00:00Z': { status: 'skipped' } } });
  await putDoc(s.port, 'slacks', 0, { schemaVersion: 1, records: [{ id: 'r1', sessionId: 'a|2026-11-12T02:00:00Z', startMs: 1 }] });
});
after(async () => {
  await s.cleanup();
});

describe('backup: GET /api/export', () => {
  it('returns one JSON file with schemaVersion, config, marks, slacks and the calendar text, as a download', async () => {
    const r = await s.request({ path: '/api/export' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /^attachment; filename="tuition-ticker-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.equal(r.json.app, 'tuition-ticker');
    assert.equal(r.json.kind, 'backup');
    assert.equal(r.json.schemaVersion, 1);
    assert.equal(r.json.config.tuition.defaultMinor, 39800000);
    assert.equal(r.json.marks.marks['a|2026-11-12T02:00:00Z'].status, 'skipped');
    assert.equal(r.json.slacks.records.length, 1);
    assert.equal(r.json.calendars.length, 1);
    assert.equal(r.json.calendars[0].text, ICS);
    for (const name of ['config', 'marks', 'slacks']) assert.equal('rev' in r.json[name], false, `${name} carries a rev`);
  });

  it('never contains a subscription link, even when a calendar is fed by one', async () => {
    fs.writeFileSync(path.join(s.dataDir, 'subscriptions.json'), JSON.stringify({ schemaVersion: 1, subscriptions: [{ id: 'cal-x', url: 'https://secret.example/private-token.ics', addedMs: 1, lastSyncMs: 2, lastError: null }] }));
    const r = await s.request({ path: '/api/export' });
    assert.equal(r.status, 200);
    assert.equal(r.text.includes('secret.example'), false);
    assert.equal(r.text.includes('private-token'), false);
    assert.equal('subscriptions' in r.json, false);
    fs.rmSync(path.join(s.dataDir, 'subscriptions.json'));
  });

  it('only answers GET', async () => {
    const r = await s.request({ method: 'POST', path: '/api/export', write: true });
    assert.equal(r.status, 405);
  });
});

describe('backup: POST /api/import', () => {
  it('export -> change things -> import restores them exactly, and the data before the import is backed up first', async () => {
    const before = await snapshot();
    const exported = (await s.request({ path: '/api/export' })).json;
    // change everything
    const cfg = (await s.request({ path: '/api/data' })).json.config;
    await putDoc(s.port, 'config', cfg.rev, { schemaVersion: 1, tuition: { defaultMinor: 100 }, currency: 'USD' });
    await s.request({ method: 'POST', path: '/api/calendars', write: true, headers: { 'Content-Type': 'text/calendar' }, body: ICS2 });
    const changed = await snapshot();
    assert.notDeepEqual(changed, before);
    const backupsBefore = backupsOf().length;

    const r = await postImport(exported);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.calendars, 1);
    assert.deepEqual(await snapshot(), before);

    // a new "before import" copy exists and holds the data as it was just before (the changed tuition)
    const after = backupsOf();
    assert.equal(after.length, backupsBefore + 1);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'backups', after.at(-1)), 'utf8'));
    assert.equal(saved.config.tuition.defaultMinor, 100);
    assert.equal(saved.calendars.length, 2);
  });

  it('bumps the rev of every document, so a page that is still open notices (its next save conflicts)', async () => {
    const exported = (await s.request({ path: '/api/export' })).json;
    const revs = (await s.request({ path: '/api/data' })).json;
    assert.equal((await postImport(exported)).status, 200);
    const next = (await s.request({ path: '/api/data' })).json;
    for (const name of ['config', 'marks', 'slacks']) assert.equal(next[name].rev, revs[name].rev + 1);
    const stale = await putDoc(s.port, 'config', revs.config.rev, { schemaVersion: 1 });
    assert.equal(stale.status, 409);
  });

  it('keeps the subscription record of a calendar that is in the backup and drops the others; the link itself never leaves the data folder', async () => {
    const exported = (await s.request({ path: '/api/export' })).json;
    const id = exported.calendars[0].id;
    fs.writeFileSync(
      path.join(s.dataDir, 'subscriptions.json'),
      JSON.stringify({ schemaVersion: 1, subscriptions: [{ id, url: 'https://keep.example/a.ics' }, { id: 'cal-gone', url: 'https://drop.example/b.ics' }] }),
    );
    assert.equal((await postImport(exported)).status, 200);
    const subs = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'subscriptions.json'), 'utf8')).subscriptions;
    assert.deepEqual(subs.map((x) => x.id), [id]);
    fs.rmSync(path.join(s.dataDir, 'subscriptions.json'));
  });

  it('refuses invalid files with 400 and changes nothing (no backup either): missing field, wrong schemaVersion, wrong marker, bad calendars, not JSON', async () => {
    const good = (await s.request({ path: '/api/export' })).json;
    const before = await snapshot();
    const backups = backupsOf().length;
    const bad = [
      ['missing config', { ...good, config: undefined }],
      ['missing slacks', (({ slacks, ...rest }) => rest)(good)],
      ['wrong schemaVersion', { ...good, schemaVersion: 2 }],
      ['no schemaVersion', (({ schemaVersion, ...rest }) => rest)(good)],
      ['doc with another schemaVersion', { ...good, marks: { ...good.marks, schemaVersion: 7 } }],
      ['wrong marker', { ...good, app: 'something-else' }],
      ['wrong kind', { ...good, kind: 'config' }],
      ['calendars not a list', { ...good, calendars: 'x' }],
      ['calendar without id', { ...good, calendars: [{ text: ICS }] }],
      ['calendar with an unsafe id', { ...good, calendars: [{ id: '../evil', text: ICS }] }],
      ['calendar that is not iCalendar', { ...good, calendars: [{ id: 'ok', text: 'hello' }] }],
      ['duplicate calendar ids', { ...good, calendars: [{ id: 'a', text: ICS }, { id: 'a', text: ICS }] }],
      ['an array', []],
      ['null', null],
    ];
    for (const [name, body] of bad) {
      const r = await postImport(body);
      assert.equal(r.status, 400, `${name}: ${r.status} ${r.text}`);
      assert.ok(r.json.error, name);
    }
    assert.equal((await postImport(undefined, { json: undefined, body: '{not json' })).status, 400);
    assert.equal((await postImport({ ...good, schemaVersion: 2 })).json.error, 'unsupported_version');
    assert.deepEqual(await snapshot(), before);
    assert.equal(backupsOf().length, backups, 'a refused import must not leave a backup behind');
  });

  it('refuses a request without the X-Tuition-Ticker header', async () => {
    const good = (await s.request({ path: '/api/export' })).json;
    const r = await s.request({ method: 'POST', path: '/api/import', json: good });
    assert.equal(r.status, 403);
  });

  it('accepts a backup larger than 5 MB (the import limit is 20 MB) and refuses one over 20 MB', async () => {
    const good = (await s.request({ path: '/api/export' })).json;
    const filler = `BEGIN:VCALENDAR\r\n${'X-FILL:'.padEnd(1000, 'a')}\r\n`.repeat(1);
    const bigText = `BEGIN:VCALENDAR\r\n${(`${filler}\r\n`).repeat(6500)}END:VCALENDAR\r\n`;
    assert.ok(Buffer.byteLength(bigText) > 6 * 1024 * 1024);
    const big = { ...good, calendars: [{ id: 'cal-big', text: bigText }] };
    const ok = await postImport(big);
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    const huge = { ...good, calendars: [{ id: 'cal-huge', text: `BEGIN:VCALENDAR\r\n${'x'.repeat(21 * 1024 * 1024)}` }] };
    const r = await postImport(huge);
    assert.equal(r.status, 413);
    // other endpoints keep the 5 MB limit
    const other = await s.request({ method: 'POST', path: '/api/calendars', write: true, headers: { 'Content-Type': 'text/calendar' }, body: bigText });
    assert.equal(other.status, 413);
  });
});
