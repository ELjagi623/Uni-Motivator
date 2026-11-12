// Request handler: security checks, the small /api surface, and static hosting for everything else.
//
//   GET  /api/health          -> { app: "tuition-ticker", version }
//   GET  /api/data            -> { config, marks, slacks, calendars }
//   PUT  /api/docs/:name      -> body { rev, doc }; name is one of config | marks | slacks
//                                200 { rev } | 409 { error, rev, doc } when rev is stale
//
// Calendar upload / sync / export endpoints belong to later phases.

import { StoreError, isDocName } from './store.js';
import { HttpError, assertRequestAllowed, readBody } from './security.js';
import { serveStatic } from './static.js';

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

export function createHandler({ store, getPort, appDir, version }) {
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
