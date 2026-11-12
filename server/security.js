// Request-level protections for a service that only ever talks to the local browser.
//   1. Host header must be 127.0.0.1:<port> or localhost:<port>   (blocks DNS-rebinding)
//   2. Any state-changing request must carry `X-Tuition-Ticker: 1` (a custom header forces a CORS
//      preflight, which this server never approves, so other websites cannot write to it)
//   3. Request bodies are capped at 5 MB (413 beyond that)

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const CSRF_HEADER = 'x-tuition-ticker';
export const SAFE_METHODS = new Set(['GET', 'HEAD']);

// Past this many bytes we stop being polite (draining so the client can read the 413) and cut the connection.
const HARD_DRAIN_LIMIT = 64 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** @returns {boolean} whether the Host header is an allowed local origin for the given port */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Throws HttpError(403) when the request must be refused. `port` is the port this server is bound to. */
export function assertRequestAllowed(req, port) {
  if (!isAllowedHost(req.headers.host, port)) {
    throw new HttpError(403, 'bad_host', 'Host header not allowed');
  }
  if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
    throw new HttpError(403, 'missing_header', 'X-Tuition-Ticker: 1 header required for write requests');
  }
}

/**
 * Collect the request body (Buffer). Rejects with HttpError(413) when it exceeds `limit` bytes.
 * Oversized bodies are drained (not stored) before answering so that clients still receive the 413.
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limit;
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) tooLarge = true;
      if (tooLarge) {
        chunks.length = 0;
        if (total > HARD_DRAIN_LIMIT) {
          reject(new HttpError(413, 'body_too_large', 'request body too large'));
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, 'body_too_large', 'request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}
