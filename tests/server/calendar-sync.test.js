import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../../server/store.js';
import { startServer } from '../../server/index.js';
import { SYNC_INTERVAL_MS, SYNC_MAX_BYTES, SYNC_TIMEOUT_MS, SyncError, createCalendarSync, fetchCalendarText, parseSubscriptionUrl } from '../../server/calendar-sync.js';
import { startIcsServer } from '../helpers/ics-server.mjs';
import { makeAppDir, makeTempDir, removeDir, request } from './helpers.js';

const ICS_A = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//a//a//EN\r\nBEGIN:VEVENT\r\nUID:a@t\r\nDTSTART:20261112T020000Z\r\nDTEND:20261112T050000Z\r\nSUMMARY:AAAA1000 First\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const ICS_B = ICS_A.replace('20261112T020000Z', '20261112T030000Z');

let src;
before(async () => {
  src = await startIcsServer({ text: ICS_A });
});
after(async () => {
  await src.close();
});

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

describe('calendar-sync: which links are accepted', () => {
  it('accepts http and https (and webcal, which is https), rejects file://, ftp:// and things that are not links', () => {
    assert.equal(parseSubscriptionUrl('http://127.0.0.1:1/a.ics').protocol, 'http:');
    assert.equal(parseSubscriptionUrl('https://example.invalid/a.ics').protocol, 'https:');
    assert.equal(parseSubscriptionUrl('webcal://example.invalid/a.ics').protocol, 'https:');
    for (const bad of ['file:///etc/passwd', 'ftp://example.invalid/a.ics', 'javascript:alert(1)', 'not a url', '', '   ', 'http://', 42, null, undefined]) {
      assert.throws(() => parseSubscriptionUrl(bad), (err) => err instanceof SyncError && err.code === 'bad_url', String(bad));
    }
  });

  it('downloads over http from a local source and over https through an injected fetch', async () => {
    assert.equal(await fetchCalendarText(src.url), ICS_A);
    const seen = [];
    const fake = async (url) => {
      seen.push(String(url));
      return new Response(ICS_A, { status: 200 });
    };
    assert.equal(await fetchCalendarText('https://calendar.example.invalid/feed.ics', { fetchImpl: fake }), ICS_A);
    assert.deepEqual(seen, ['https://calendar.example.invalid/feed.ics']);
  });

  it('has the documented limits: 15 s, 5 MB, 6 hours', () => {
    assert.equal(SYNC_TIMEOUT_MS, 15_000);
    assert.equal(SYNC_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(SYNC_INTERVAL_MS, 6 * 60 * 60 * 1000);
  });
});

describe('calendar-sync: what is refused', () => {
  it('refuses an answer larger than 5 MB (also when the server does not announce the size)', async () => {
    const base = src.url.replace('/calendar.ics', '');
    const err = await rejection(fetchCalendarText(`${base}/big.ics`));
    assert.equal(err.code, 'too_large');
    const streamed = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\r\n')); c.enqueue(new Uint8Array(2000)); c.close(); } }), { status: 200 });
    assert.equal((await rejection(fetchCalendarText('http://127.0.0.1:1/x.ics', { fetchImpl: streamed, maxBytes: 1000 }))).code, 'too_large');
  });

  it('refuses an answer that does not start with BEGIN:VCALENDAR', async () => {
    const base = src.url.replace('/calendar.ics', '');
    assert.equal((await rejection(fetchCalendarText(`${base}/plain.ics`))).code, 'not_icalendar');
  });

  it('refuses when the source is too slow (timeout)', async () => {
    const slow = await startIcsServer({ text: ICS_A });
    slow.setDelay(400);
    try {
      const err = await rejection(fetchCalendarText(slow.url, { timeoutMs: 60 }));
      assert.equal(err.code, 'timeout');
    } finally {
      await slow.close();
    }
  });

  it('refuses a non-2xx answer and an unreachable source, each with a fixed message', async () => {
    const down = await startIcsServer({ text: ICS_A });
    const url = down.url;
    down.setStatus(503);
    assert.equal((await rejection(fetchCalendarText(url))).code, 'http_error');
    await down.close();
    assert.equal((await rejection(fetchCalendarText(url))).code, 'network');
  });
});

describe('calendar-sync: subscriptions in a data folder', () => {
  it('stores the calendar, keeps the old file when a sync fails, and never leaks the link', async () => {
    const dir = makeTempDir('tt-sync-');
    const log = [];
    try {
      const store = createStore({ dataDir: dir });
      const sync = createCalendarSync({ store, log: (l) => log.push(l), timeoutMs: 200 });
      const link = `${src.url}?token=SECRET-TOKEN-123`;
      src.setText(ICS_A);
      const added = await sync.addSubscription(link);
      assert.match(added.calendarId, /^sub-[0-9a-f]{10}$/);
      assert.equal(fs.readFileSync(path.join(dir, 'calendars', `${added.calendarId}.ics`), 'utf8'), ICS_A);

      // a changed source is picked up (same calendar id)
      src.setText(ICS_B);
      const changed = await sync.syncCalendar(added.calendarId);
      assert.equal(changed.changed, true);
      assert.equal(fs.readFileSync(path.join(dir, 'calendars', `${added.calendarId}.ics`), 'utf8'), ICS_B);
      assert.equal((await sync.syncCalendar(added.calendarId)).changed, false);

      // failures: the stored text is not touched, the error says what happened but not where
      const failures = [];
      for (const make of [() => src.setStatus(500), () => { src.setStatus(200); src.setText('hello'); }, () => { src.setText(ICS_B); src.setDelay(500); }]) {
        make();
        const err = await rejection(sync.syncCalendar(added.calendarId));
        failures.push(err);
        assert.equal(fs.readFileSync(path.join(dir, 'calendars', `${added.calendarId}.ics`), 'utf8'), ICS_B, 'the old calendar must stay');
      }
      src.setDelay(0);
      assert.deepEqual(failures.map((e) => e.code), ['http_error', 'not_icalendar', 'timeout']);
      const everything = [...failures.map((e) => `${e.message} ${e.stack}`), ...log, JSON.stringify(store.readAll())].join('\n');
      assert.ok(!everything.includes('SECRET-TOKEN-123'), 'the token must not appear in errors, logs or the API view');
      assert.ok(!everything.includes(`127.0.0.1:${src.port}`), 'the address must not appear either');
      assert.equal(store.readAll().subscriptions[0].lastError, 'timeout');
      // the link itself is kept on disk for the next sync, but only in subscriptions.json
      assert.ok(fs.readFileSync(path.join(dir, 'subscriptions.json'), 'utf8').includes('SECRET-TOKEN-123'));

      // a failed first download stores nothing
      const before = store.readSubscriptions().length;
      src.setStatus(500);
      await rejection(sync.addSubscription(`${src.url}?another=1`));
      assert.equal(store.readSubscriptions().length, before);
      src.setStatus(200);
      // the same link twice
      assert.equal((await rejection(sync.addSubscription(link))).code, 'already_subscribed');
      // unknown calendar
      assert.equal((await rejection(sync.syncCalendar('cal-none'))).code, 'not_found');
      // deleting the calendar drops the subscription
      assert.equal(store.deleteCalendar(added.calendarId), true);
      assert.deepEqual(store.readSubscriptions(), []);
    } finally {
      src.setStatus(200);
      src.setDelay(0);
      removeDir(dir);
    }
  });

  it('syncs once when started and then whenever the injected timer fires; the timer is unref\'d and 6 hours long', async () => {
    const dir = makeTempDir('tt-sync-');
    try {
      const store = createStore({ dataDir: dir });
      src.setText(ICS_A);
      const first = createCalendarSync({ store });
      const { calendarId } = await first.addSubscription(src.url);
      src.setText(ICS_B);
      const timers = [];
      const cleared = [];
      const sync = createCalendarSync({
        store,
        setIntervalFn: (fn, ms) => {
          const t = { fn, ms, unref() { this.unrefd = true; } };
          timers.push(t);
          return t;
        },
        clearIntervalFn: (t) => cleared.push(t),
      });
      const requestsBefore = src.requests;
      sync.start();
      sync.start(); // idempotent
      await new Promise((r) => setTimeout(r, 150)); // the start-up sync runs in the background
      assert.equal(src.requests - requestsBefore, 1, 'one sync at start');
      assert.equal(fs.readFileSync(path.join(dir, 'calendars', `${calendarId}.ics`), 'utf8'), ICS_B);
      assert.equal(timers.length, 1);
      assert.equal(timers[0].ms, 6 * 60 * 60 * 1000);
      assert.equal(timers[0].unrefd, true);

      src.setText(ICS_A);
      timers[0].fn(); // "six hours later"
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(src.requests - requestsBefore, 2, 'the timer fires one more sync');
      assert.equal(fs.readFileSync(path.join(dir, 'calendars', `${calendarId}.ics`), 'utf8'), ICS_A);
      sync.stop();
      assert.equal(cleared.length, 1);
    } finally {
      removeDir(dir);
    }
  });
});

describe('calendar-sync: through the HTTP API and at server start', () => {
  let dataDir;
  let appDir;
  let instance;
  before(async () => {
    dataDir = makeTempDir('tt-sync-api-');
    appDir = makeAppDir();
    instance = await startServer({ port: 0, dataDir, appDir, version: 'test' });
  });
  after(async () => {
    await instance.close();
    removeDir(dataDir);
    removeDir(appDir);
  });

  const api = (opts) => request(instance.port, { write: true, ...opts });

  it('POST /api/subscriptions downloads the link, answers without it, and GET /api/data lists the subscription without it', async () => {
    src.setText(ICS_A);
    const link = `${src.url}?key=PRIVATE-KEY-777`;
    const r = await api({ method: 'POST', path: '/api/subscriptions', json: { url: link } });
    assert.equal(r.status, 201);
    assert.match(r.json.calendarId, /^sub-/);
    assert.ok(!JSON.stringify(r.json).includes('PRIVATE-KEY-777'));
    const data = await api({ path: '/api/data' });
    assert.equal(data.json.calendars.length, 1);
    assert.equal(data.json.calendars[0].text, ICS_A);
    assert.deepEqual(Object.keys(data.json.subscriptions[0]).sort(), ['addedMs', 'calendarId', 'lastError', 'lastSyncMs']);
    assert.ok(!data.text.includes('PRIVATE-KEY-777'));
    assert.ok(!data.text.includes(`127.0.0.1:${src.port}`));

    // sync endpoint
    src.setText(ICS_B);
    const s = await api({ method: 'POST', path: `/api/calendars/${r.json.calendarId}/sync` });
    assert.equal(s.status, 200);
    assert.equal(s.json.changed, true);
    assert.equal((await api({ path: '/api/data' })).json.calendars[0].text, ICS_B);

    // failure: 502 with a code, no link, and the calendar stays
    src.setStatus(500);
    const bad = await api({ method: 'POST', path: `/api/calendars/${r.json.calendarId}/sync` });
    assert.equal(bad.status, 502);
    assert.equal(bad.json.error, 'http_error');
    assert.ok(!bad.text.includes('PRIVATE-KEY-777'));
    assert.ok(!bad.text.includes(String(src.port)));
    src.setStatus(200);
    const after = await api({ path: '/api/data' });
    assert.equal(after.json.calendars[0].text, ICS_B);
    assert.equal(after.json.subscriptions[0].lastError, 'http_error');

    // deleting the calendar removes the subscription
    const del = await api({ method: 'DELETE', path: `/api/calendars/${r.json.calendarId}` });
    assert.equal(del.status, 200);
    assert.deepEqual((await api({ path: '/api/data' })).json.subscriptions, []);
  });

  it('rejects bad links, unknown calendars and missing write headers', async () => {
    const bad = await api({ method: 'POST', path: '/api/subscriptions', json: { url: 'file:///etc/hosts' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'bad_url');
    assert.ok(!bad.text.includes('hosts'));
    assert.equal((await api({ method: 'POST', path: '/api/subscriptions', json: { nope: 1 } })).status, 400);
    assert.equal((await api({ method: 'POST', path: '/api/calendars/cal-unknown/sync' })).status, 404);
    assert.equal((await api({ method: 'POST', path: '/api/calendars/..%2Fx/sync' })).status, 400);
    assert.equal((await api({ method: 'GET', path: '/api/calendars/cal-x/sync' })).status, 405);
    const noHeader = await request(instance.port, { method: 'POST', path: '/api/subscriptions', json: { url: src.url } });
    assert.equal(noHeader.status, 403);
  });

  it('synchronises once when the server starts', async () => {
    const dir = makeTempDir('tt-sync-start-');
    const app = makeAppDir();
    try {
      src.setText(ICS_B);
      const seed = createCalendarSync({ store: createStore({ dataDir: dir }) });
      const { calendarId } = await seed.addSubscription(src.url);
      fs.writeFileSync(path.join(dir, 'calendars', `${calendarId}.ics`), ICS_A); // the stored copy is out of date
      const before = src.requests;
      const started = await startServer({ port: 0, dataDir: dir, appDir: app, version: 'test' });
      try {
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(src.requests - before, 1);
        assert.equal(fs.readFileSync(path.join(dir, 'calendars', `${calendarId}.ics`), 'utf8'), ICS_B);
      } finally {
        await started.close();
      }
    } finally {
      removeDir(dir);
      removeDir(app);
    }
  });
});
