// Request handler: security checks, the small /api surface, and static hosting for everything else.
//
//   GET  /api/health          -> { app: "tuition-ticker", version }
//   GET  /api/data            -> { config, marks, slacks, calendars }
//   PUT  /api/docs/:name      -> body { rev, doc }; name is one of config | marks | slacks
//                                200 { rev } | 409 { error, rev, doc } when rev is stale
//   POST   /api/calendars     -> body: the .ics text (UTF-8); 201 { id } | 400 when it is not an iCalendar file
//   DELETE /api/calendars/:id -> 200 { ok: true } | 400 unsafe id | 404 unknown id
//
//   POST /api/subscriptions   -> body { url }; downloads the link first; 201 { calendarId, lastSyncMs } (the link is never echoed)
//   POST /api/calendars/:id/sync -> re-download a subscribed calendar; 200 { calendarId, lastSyncMs, changed }
//                                   404 when the calendar has no subscription, 400 bad link, 502 { error: <code> } when the
//                                   download failed (the stored calendar is untouched)
//   GET /api/data also lists `subscriptions`: [{calendarId, addedMs, lastSyncMs, lastError}] - never the links.
//
//   GET  /api/export          -> the whole data as one JSON file: { app, kind: "backup", schemaVersion, exportedAt, config, marks,
//                                slacks, calendars: [{id, text}] } (no rev numbers, no subscription links), sent as a download
//   POST /api/import          -> body: such a file. Validated first (structure, schemaVersion); 400 and nothing changed when it is
//                                not valid. Otherwise the current data is copied to data/backups/<stamp>_before-import.json and
//                                then replaced. 200 { ok, backup, calendars }. The body limit is 20 MB here (5 MB elsewhere):
//                                a backup carries every calendar, so it can be larger than any single request.

import { StoreError, isCalendarId, isDocName } from './store.js';
import { HttpError, MAX_IMPORT_BYTES, assertRequestAllowed, readBody } from './security.js';
import { serveStatic } from './static.js';
import { SyncError } from './calendar-sync.js';

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

function apiSegments(rawUrl) {
  const target = String(rawUrl ?? '/');
  const cut = target.search(/[?#]/);
  const rawPath = cut === -1 ? target : target.slice(0, cut);
  return rawPath.split('/').filter((s) => s !== '');
}

function isApiPath(rawUrl) {
  const [first] = apiSegments(rawUrl);
  return first === 'api';
}

function parseJsonBody(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
  }
  return value;
}

export function createHandler({ store, getPort, appDir, version, sync }) {
  async function handleApi(req, res) {
    const [, ...rest] = apiSegments(req.url);
    let decoded;
    try {
      decoded = rest.map((s) => decodeURIComponent(s));
    } catch {
      throw new HttpError(400, 'bad_url', 'malformed URL');
    }
    const method = req.method;

    if (decoded.length === 1 && decoded[0] === 'health') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
      sendJson(res, 200, { app: 'tuition-ticker', version });
      return;
    }

    if (decoded.length === 1 && decoded[0] === 'data') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
      sendJson(res, 200, store.readAll());
      return;
    }

    if (decoded.length === 1 && decoded[0] === 'export') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      const day = new Date(Date.now()).toISOString().slice(0, 10);
      sendJson(res, 200, store.exportBackup(), { 'Content-Disposition': `attachment; filename="tuition-ticker-backup-${day}.json"` });
      return;
    }

    if (decoded.length === 1 && decoded[0] === `import`) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      const payload = parseJsonBody(await readBody(req, MAX_IMPORT_BYTES));
      const checked = store.validateBackup(payload);
      if (!checked.ok) throw new HttpError(400, checked.code, checked.message);
      const result = store.importBackup(payload);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (decoded.length === 2 && decoded[0] === 'docs') {
      const name = decoded[1];
      if (!isDocName(name)) throw new HttpError(404, 'not_found', 'unknown document');
      if (method !== 'PUT') throw new HttpError(405, 'method_not_allowed');
      const payload = parseJsonBody(await readBody(req));
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HttpError(400, 'bad_request', 'body must be an object { rev, doc }');
      }
      const { rev, doc } = payload;
      if (!Number.isInteger(rev) || rev < 0) throw new HttpError(400, 'bad_rev', 'rev must be a non-negative integer');
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new HttpError(400, 'bad_doc', 'doc must be a JSON object');
      }
      const result = store.writeDoc(name, rev, doc);
      if (result.ok) {
        sendJson(res, 200, { rev: result.rev });
      } else {
        sendJson(res, 409, { error: 'rev_conflict', rev: result.current.rev, doc: result.current });
      }
      return;
    }

    if (decoded.length === 1 && decoded[0] === 'subscriptions') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      const payload = parseJsonBody(await readBody(req));
      if (payload === null || typeof payload !== 'object' || typeof payload.url !== 'string') throw new HttpError(400, 'bad_request', 'body must be an object { url }');
      const result = await sync.addSubscription(payload.url);
      sendJson(res, 201, result);
      return;
    }

    if (decoded[0] === 'calendars') {
      if (decoded.length === 3 && decoded[2] === 'sync') {
        if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
        if (!isCalendarId(decoded[1])) throw new HttpError(400, 'bad_id', 'calendar id contains characters that are not allowed');
        await readBody(req);
        sendJson(res, 200, await sync.syncCalendar(decoded[1]));
        return;
      }
      if (decoded.length === 1) {
        if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
        const text = (await readBody(req)).toString('utf8').replace(/^﻿/, '');
        if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new HttpError(400, 'not_icalendar', 'body must be iCalendar text starting with BEGIN:VCALENDAR');
        const { id } = store.addCalendar(text);
        sendJson(res, 201, { id });
        return;
      }
      if (decoded.length === 2) {
        if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed');
        if (!isCalendarId(decoded[1])) throw new HttpError(400, 'bad_id', 'calendar id contains characters that are not allowed');
        if (!store.deleteCalendar(decoded[1])) throw new HttpError(404, 'not_found', 'no such calendar');
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    throw new HttpError(404, 'not_found', 'no such API endpoint');
  }

  return async function handler(req, res) {
    res.req = req;
    try {
      assertRequestAllowed(req, getPort());
      if (isApiPath(req.url)) await handleApi(req, res);
      else serveStatic(req, res, appDir);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        const headers = err.status === 413 ? { Connection: 'close' } : {};
        sendJson(res, err.status, { error: err.code, message: err.message }, headers);
      } else if (err instanceof SyncError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else if (err instanceof StoreError) {
        const status = err.code === 'corrupt' ? 500 : 400;
        sendJson(res, status, { error: err.code, message: err.message });
      } else {
        // Never leak stack traces or file paths to the client.
        console.error('[server] unexpected error:', err);
        sendJson(res, 500, { error: 'internal_error', message: 'internal server error' });
      }
    }
  };
}
