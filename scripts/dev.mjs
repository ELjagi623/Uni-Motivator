#!/usr/bin/env node
// `npm run dev`: start the local server (no browser, never reusing another instance, so TT_DATA_DIR is honoured)
// and a Vite dev server whose /api proxy points at it.
//
//   env: TT_DATA_DIR (data directory), TT_DEV_API_PORT (first port tried for the API, default 4300),
//        TT_VITE_PORT (Vite port, default 5173)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = process.env.TT_DEV_API_PORT || '4300';

const server = spawn(process.execPath, ['server/index.js', '--no-open', '--no-reuse', '--port', apiPort], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'pipe', 'inherit'],
});

let vite;
const stopAll = (code = 0) => {
  if (vite) void vite.close();
  if (server.exitCode === null) server.kill();
  process.exitCode = code;
};
server.on('exit', (code) => {
  if (!vite) {
    console.error(`[dev] the local server exited early (code ${code})`);
    process.exit(code || 1);
  }
  console.error(`[dev] the local server stopped (code ${code}); shutting down`);
  void vite.close().then(() => process.exit(code || 0));
});
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

let buffered = '';
let started = false;
server.stdout.on('data', async (chunk) => {
  const text = String(chunk);
  process.stdout.write(`[server] ${text}`);
  if (started) return;
  buffered += text;
  const m = buffered.match(/^TUITION_TICKER_URL=(http:\/\/127\.0\.0\.1:\d+)/m);
  if (!m) return;
  started = true;
  process.env.TT_API_TARGET = m[1];
  const { createServer } = await import('vite');
  vite = await createServer({
    root,
    server: { port: Number(process.env.TT_VITE_PORT || 5173) },
  });
  await vite.listen();
  vite.printUrls();
  console.log(`[dev] /api is proxied to ${m[1]}`);
});
