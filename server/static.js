// Static hosting of the built front-end (app/). Unknown paths fall back to index.html (hash-routed SPA).
// Path traversal is refused up front; the URL is decoded by hand because WHATWG URL parsing would silently
// collapse "%2e%2e" segments into a different (valid) path.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.wasm': 'application/wasm',
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Turn a raw request target into a normalized, decoded relative path, or an error.
 * @returns {{ok: true, segments: string[]} | {ok: false, status: number}}
 */
export function resolveRequestPath(rawUrl) {
  const target = String(rawUrl ?? '/');
  const cut = target.search(/[?#]/);
  const rawPath = cut === -1 ? target : target.slice(0, cut);
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, status: 400 };
  }
  // NUL bytes, drive/stream markers (C:, file.txt::$DATA) and backslashes are never legitimate here.
  if (/[\0:\\]/.test(decoded)) return { ok: false, status: 403 };
  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return { ok: false, status: 403 };
  return { ok: true, segments };
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extra,
  });
  res.end(body);
}

function sendFile(req, res, filePath, stat, extraHeaders = {}) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    ...extraHeaders,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function statFile(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Serve `req` from `appDir`. Resolves once a response has been started. */
export function serveStatic(req, res, appDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }
  const resolved = resolveRequestPath(req.url);
  if (!resolved.ok) {
    sendText(res, resolved.status, resolved.status === 400 ? 'Bad Request' : 'Forbidden');
    return;
  }

  const root = path.resolve(appDir);
  const indexFile = path.join(root, 'index.html');
  const indexStat = statFile(indexFile);
  if (!indexStat) {
    sendText(res, 503, 'The front-end has not been built yet. Run "npm run build" (or start.cmd) first.');
    return;
  }

  const candidate = path.resolve(root, ...resolved.segments);
  if (!isInside(root, candidate)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  const stat = resolved.segments.length > 0 ? statFile(candidate) : null;
  if (stat) {
    // A symlink inside app/ must not lead outside of it either.
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      real = null;
    }
    if (!real || !isInside(fs.realpathSync(root), real)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    const hashed = resolved.segments[0] === 'assets';
    sendFile(req, res, candidate, stat, {
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return;
  }
  // SPA fallback.
  sendFile(req, res, indexFile, indexStat, { 'Cache-Control': 'no-cache' });
}
