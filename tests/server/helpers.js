// Shared helpers for the node:test server tests. Every test uses its own temp data dir and a random port.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const serverEntry = path.join(projectRoot, 'server', 'index.js');

export function makeTempDir(prefix = 'tt-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A fake built front-end so static tests do not depend on `npm run build`. */
export function makeAppDir(files = {}) {
  const dir = makeTempDir('tt-app-');
  const all = { 'index.html': '<!doctype html><title>fixture-index</title>', ...files };
  for (const [name, content] of Object.entries(all)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

/** Start an in-process server on a random port with fresh temp dirs; returns helpers + cleanup. */
export async function withServer({ appFiles } = {}) {
  const dataDir = makeTempDir('tt-data-');
  const appDir = makeAppDir(appFiles);
  const instance = await startServer({ port: 0, dataDir, appDir, version: '9.9.9-test' });
  return {
    ...instance,
    dataDir,
    appDir,
    request: (opts) => request(instance.port, opts),
    async cleanup() {
      await instance.close();
      removeDir(dataDir);
      removeDir(appDir);
    },
  };
}

/**
 * Raw HTTP request (no URL normalisation, so odd paths reach the server untouched).
 * `write: true` adds the X-Tuition-Ticker header; `json` is serialised as the body.
 */
export function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body, json, write = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (write) h['X-Tuition-Ticker'] = '1';
    let payload = body;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      h['Content-Type'] = 'application/json';
    }
    if (payload !== undefined && h['Content-Length'] === undefined && !h['Transfer-Encoding']) {
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function putDoc(port, name, rev, doc, extra = {}) {
  return request(port, { method: 'PUT', path: `/api/docs/${name}`, write: true, json: { rev, doc }, ...extra });
}

/** Spawn `node server/index.js ...` and collect stdout; resolves helpers to wait for lines / exit. */
export function spawnServer(args, { env = {}, cwd = projectRoot } = {}) {
  const child = spawn(process.execPath, [serverEntry, ...args], {
    cwd,
    env: { ...process.env, TT_NO_OPEN: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const waitForLine = (re, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const m = stdout.match(re);
        if (m) return resolve(m);
        if (child.exitCode !== null) return reject(new Error(`process exited (${child.exitCode}) before ${re}; stdout=${stdout} stderr=${stderr}`));
        if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${re}; stdout=${stdout} stderr=${stderr}`));
        setTimeout(tick, 25);
      };
      tick();
    });
  return {
    child,
    exited,
    waitForLine,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

/** Find `count` consecutive free ports starting near `start`. */
export async function findFreePorts(count = 3, start = 4600) {
  const isFree = (port) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen({ port, host: '127.0.0.1' }, () => s.close(() => resolve(true)));
    });
  for (let base = start; base < start + 2000; base += 1) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await isFree(base + i);
    if (ok) return base;
  }
  throw new Error('no free port range');
}

export function isListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}
