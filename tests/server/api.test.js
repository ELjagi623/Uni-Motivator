import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withServer, putDoc } from './helpers.js';

let s;
before(async () => {
  s = await withServer();
});
after(async () => {
  await s.cleanup();
});

describe('api: health and data', () => {
  it('GET /api/health identifies the app and reports the version', async () => {
    const r = await s.request({ path: '/api/health' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { app: 'tuition-ticker', version: '9.9.9-test' });
  });

  it('GET /api/data returns empty documents (schemaVersion 1, rev 0) when nothing is stored', async () => {
    const r = await s.request({ path: '/api/data' });
    assert.equal(r.status, 200);
    for (const name of ['config', 'marks', 'slacks']) {
      assert.deepEqual(r.json[name], { schemaVersion: 1, rev: 0 });
    }
    assert.deepEqual(r.json.calendars, []);
  });

  it('GET /api/data includes calendars found in data/calendars', async () => {
    fs.mkdirSync(path.join(s.dataDir, 'calendars'), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'calendars', 'abc.ics'), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    const r = await s.request({ path: '/api/data' });
    assert.deepEqual(r.json.calendars, [{ id: 'abc', text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }]);
    fs.rmSync(path.join(s.dataDir, 'calendars'), { recursive: true });
  });

  it('answers unknown API paths with 404 JSON (never the SPA fallback) and wrong methods with 405', async () => {
    const a = await s.request({ path: '/api/nope' });
    assert.equal(a.status, 404);
    assert.equal(a.json.error, 'not_found');
    const b = await s.request({ method: 'POST', path: '/api/health', write: true });
    assert.equal(b.status, 405);
    const c = await s.request({ method: 'GET', path: '/api/docs/config' });
    assert.equal(c.status, 405);
  });
});

describe('api: PUT /api/docs/:name', () => {
  it('persists a document, returns the new rev, and GET /api/data reflects it', async () => {
    const w = await putDoc(s.port, 'config', 0, { currency: 'HKD', note: '你好' });
    assert.equal(w.status, 200);
    assert.deepEqual(w.json, { rev: 1 });
    const r = await s.request({ path: '/api/data' });
    assert.equal(r.json.config.rev, 1);
    assert.equal(r.json.config.note, '你好');
    assert.equal(r.json.config.schemaVersion, 1);
    const w2 = await putDoc(s.port, 'config', 1, { currency: 'HKD', note: 'v2' });
    assert.deepEqual(w2.json, { rev: 2 });
    assert.ok(fs.readdirSync(path.join(s.dataDir, 'backups')).some((f) => f.endsWith('_config.json')));
  });

  it('returns 409 with the server copy when rev does not match', async () => {
    const r = await putDoc(s.port, 'marks', 5, { a: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.json.rev, 0);
    assert.deepEqual(r.json.doc, { schemaVersion: 1, rev: 0 });
    await putDoc(s.port, 'marks', 0, { a: 1 });
    const stale = await putDoc(s.port, 'marks', 0, { a: 2 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.rev, 1);
    assert.equal(stale.json.doc.a, 1);
  });

  it('returns 404 for a document name outside config|marks|slacks', async () => {
    for (const name of ['evil', 'calendars', '..%2Fconfig', 'CONFIG']) {
      const r = await putDoc(s.port, name, 0, { a: 1 });
      assert.equal(r.status, 404, `PUT /api/docs/${name}`);
    }
    assert.equal(fs.existsSync(path.join(s.dataDir, 'evil.json')), false);
  });

  it('returns 400 for malformed bodies', async () => {
    const cases = [
      { body: 'not json' },
      { json: { doc: { a: 1 } } },
      { json: { rev: 'x', doc: {} } },
      { json: { rev: -1, doc: {} } },
      { json: { rev: 0, doc: [1, 2] } },
      { json: { rev: 0 } },
      { json: [1] },
    ];
    for (const c of cases) {
      const r = await s.request({ method: 'PUT', path: '/api/docs/slacks', write: true, ...c });
      assert.equal(r.status, 400, JSON.stringify(c));
    }
  });
});

describe('api: security', () => {
  it('rejects a foreign Host header with 403 (DNS rebinding)', async () => {
    for (const host of ['evil.com', `evil.com:${s.port}`, '127.0.0.1', `127.0.0.1:${s.port + 1}`, `localhost.evil.com:${s.port}`]) {
      const r = await s.request({ path: '/api/health', headers: { Host: host } });
      assert.ok([403, 421].includes(r.status), `Host ${host} -> ${r.status}`);
    }
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`]) {
      const r = await s.request({ path: '/api/health', headers: { Host: host } });
      assert.equal(r.status, 200, `Host ${host}`);
    }
  });

  it('applies the Host check to static pages too', async () => {
    const r = await s.request({ path: '/', headers: { Host: 'evil.com' } });
    assert.equal(r.status, 403);
  });

  it('rejects write requests without the X-Tuition-Ticker header (403) and writes nothing', async () => {
    const r = await s.request({ method: 'PUT', path: '/api/docs/slacks', json: { rev: 0, doc: { a: 1 } } });
    assert.equal(r.status, 403);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'slacks.json')), false);
    const wrong = await s.request({
      method: 'PUT',
      path: '/api/docs/slacks',
      headers: { 'X-Tuition-Ticker': '0' },
      json: { rev: 0, doc: { a: 1 } },
    });
    assert.equal(wrong.status, 403);
  });

  it('answers a CORS preflight without granting anything', async () => {
    const r = await s.request({
      method: 'OPTIONS',
      path: '/api/docs/config',
      headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'PUT' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  it('rejects request bodies above 5 MB with 413 and keeps the server usable', async () => {
    const big = JSON.stringify({ rev: 0, doc: { blob: 'x'.repeat(6 * 1024 * 1024) } });
    const r = await s.request({
      method: 'PUT',
      path: '/api/docs/slacks',
      write: true,
      body: big,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(r.status, 413);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'slacks.json')), false);
    const ok = await s.request({ path: '/api/health' });
    assert.equal(ok.status, 200);
  });

  it('accepts a body just under 5 MB', async () => {
    const body = JSON.stringify({ rev: 0, doc: { blob: 'x'.repeat(4 * 1024 * 1024) } });
    const r = await s.request({
      method: 'PUT',
      path: '/api/docs/slacks',
      write: true,
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(r.status, 200);
  });

  it('only binds to 127.0.0.1', async () => {
    assert.equal(s.server.address().address, '127.0.0.1');
  });
});

describe('api: calendars (POST /api/calendars, DELETE /api/calendars/:id)', () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
  const calendarsDir = () => path.join(s.dataDir, 'calendars');

  it('stores the uploaded text under calendars/<id>.ics and returns the id; GET /api/data lists it', async () => {
    const r = await s.request({ method: 'POST', path: '/api/calendars', write: true, body: ics, headers: { 'Content-Type': 'text/calendar' } });
    assert.equal(r.status, 201);
    assert.match(r.json.id, /^cal-[0-9a-f]{12}$/);
    assert.equal(fs.readFileSync(path.join(calendarsDir(), `${r.json.id}.ics`), 'utf8'), ics);
    const data = await s.request({ path: '/api/data' });
    assert.deepEqual(data.json.calendars, [{ id: r.json.id, text: ics }]);
    const d = await s.request({ method: 'DELETE', path: `/api/calendars/${r.json.id}`, write: true });
    assert.equal(d.status, 200);
    assert.equal(fs.existsSync(path.join(calendarsDir(), `${r.json.id}.ics`)), false);
  });

  it('is idempotent: the same text gives the same id and no second file', async () => {
    const a = await s.request({ method: 'POST', path: '/api/calendars', write: true, body: ics });
    const b = await s.request({ method: 'POST', path: '/api/calendars', write: true, body: ics });
    assert.equal(a.json.id, b.json.id);
    assert.equal(fs.readdirSync(calendarsDir()).length, 1);
    await s.request({ method: 'DELETE', path: `/api/calendars/${a.json.id}`, write: true });
  });

  it('rejects text that is not an iCalendar file with 400 and writes nothing', async () => {
    const r = await s.request({ method: 'POST', path: '/api/calendars', write: true, body: 'hello' });
    assert.equal(r.status, 400);
    assert.equal(fs.existsSync(calendarsDir()) && fs.readdirSync(calendarsDir()).length > 0, false);
  });

  it('refuses ids with path characters and answers 404 for an unknown safe id', async () => {
    for (const id of ['..%2Fx', '..%5Cx', 'a%2Fb', '%2e%2e', 'x.ics', 'a%20b']) {
      const r = await s.request({ method: 'DELETE', path: `/api/calendars/${id}`, write: true });
      assert.ok(r.status === 400 || r.status === 404, `${id} -> ${r.status}`);
    }
    const dotdot = await s.request({ method: 'DELETE', path: '/api/calendars/..%2Fx', write: true });
    assert.equal(dotdot.status, 400);
    const unknown = await s.request({ method: 'DELETE', path: '/api/calendars/cal-nothere', write: true });
    assert.equal(unknown.status, 404);
  });

  it('needs the X-Tuition-Ticker header and the right method', async () => {
    const noHeader = await s.request({ method: 'POST', path: '/api/calendars', body: ics });
    assert.equal(noHeader.status, 403);
    const wrong = await s.request({ method: 'GET', path: '/api/calendars' });
    assert.equal(wrong.status, 405);
  });

  it('accepts a body with a BOM and refuses one over 5 MB', async () => {
    const withBom = await s.request({ method: 'POST', path: '/api/calendars', write: true, body: `\uFEFF${ics}` });
    assert.equal(withBom.status, 201);
    await s.request({ method: 'DELETE', path: `/api/calendars/${withBom.json.id}`, write: true });
    const big = await s.request({ method: 'POST', path: '/api/calendars', write: true, body: `BEGIN:VCALENDAR\r\n${'x'.repeat(5 * 1024 * 1024 + 10)}` });
    assert.equal(big.status, 413);
  });
});
