// A tiny local HTTP server that plays the part of an iCal subscription source, for tests and manual checks.
// It only ever serves what it is told to; it never talks to the internet. NEVER use a real subscription link in tests.
//
// As a library:
//   const src = await startIcsServer({ text });      // src.url -> http://127.0.0.1:<port>/calendar.ics
//   src.setText(newText); src.setStatus(500); src.setDelay(200); src.requests (count); await src.close();
//
// From the command line (for the browser checks):
//   node tests/helpers/ics-server.mjs [--port 4600] [--file tests/fixtures/full-term.ics]
//   prints  ICS_SERVER_URL=http://127.0.0.1:4600/calendar.ics
//   control endpoints (plain GET, so they can be opened in a browser tab):
//     /__fixture?name=full-term-changed.ics   serve tests/fixtures/<name> from now on
//     /__status?code=500                      answer every /calendar.ics request with this HTTP status (200 = normal)
//     /__delay?ms=2000                        wait this long before answering
//   other paths: /plain.ics (not a calendar), /big.ics (6 MB of calendar text)
// Stopping the process ("the source goes away") makes the subscription fail with a network error.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixturesDir = path.resolve(here, '..', 'fixtures');

export const MINIMAL_ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ics-server//test//EN', 'END:VCALENDAR', ''].join('\r\n');

/** @returns {Promise<{url: string, port: number, requests: number, setText(t: string): void, setStatus(n: number): void, setDelay(ms: number): void, close(): Promise<void>}>} */
export function startIcsServer({ text = MINIMAL_ICS, port = 0, host = '127.0.0.1' } = {}) {
  const state = { text, status: 200, delay: 0, requests: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const reply = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/__fixture') {
      const name = path.basename(url.searchParams.get('name') ?? '');
      try {
        state.text = fs.readFileSync(path.join(fixturesDir, name), 'utf8');
        reply(200, `serving ${name}\n`);
      } catch {
        reply(404, 'no such fixture\n');
      }
      return;
    }
    if (url.pathname === '/__status') {
      state.status = Number(url.searchParams.get('code') ?? 200);
      reply(200, `status ${state.status}\n`);
      return;
    }
    if (url.pathname === '/__delay') {
      state.delay = Number(url.searchParams.get('ms') ?? 0);
      reply(200, `delay ${state.delay}\n`);
      return;
    }
    const send = () => {
      if (url.pathname === '/plain.ics') return reply(200, 'this is not a calendar\n');
      if (url.pathname === '/big.ics') return reply(200, `BEGIN:VCALENDAR\r\n${'X-PAD:0123456789012345678901234567890123456789\r\n'.repeat(150_000)}END:VCALENDAR\r\n`, 'text/calendar');
      if (url.pathname === '/calendar.ics') {
        if (state.status !== 200) return reply(state.status, 'error\n');
        return reply(200, state.text, 'text/calendar; charset=utf-8');
      }
      return reply(404, 'not found\n');
    };
    if (url.pathname !== '/plain.ics' && url.pathname !== '/big.ics') state.requests += url.pathname === '/calendar.ics' ? 1 : 0;
    if (state.delay > 0 && url.pathname === '/calendar.ics') setTimeout(send, state.delay);
    else send();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host }, () => {
      const bound = server.address().port;
      resolve({
        url: `http://${host}:${bound}/calendar.ics`,
        port: bound,
        get requests() {
          return state.requests;
        },
        setText: (t) => {
          state.text = t;
        },
        setStatus: (n) => {
          state.status = n;
        },
        setDelay: (ms) => {
          state.delay = ms;
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// ---------------------------------------------------------------- command line
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const file = arg('--file');
  const src = await startIcsServer({ port: Number(arg('--port') ?? 0), text: file ? fs.readFileSync(path.resolve(file), 'utf8') : MINIMAL_ICS });
  console.log(`ICS_SERVER_URL=${src.url}`);
}
