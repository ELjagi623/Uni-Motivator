// Shared helpers for the cumulative acceptance script. Node built-ins only.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const isWindows = process.platform === 'win32';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s) => String(s).replace(ANSI, '');

// ---------------------------------------------------------------- temp dirs
const tempDirs = [];
export function makeTempDir(prefix = 'tt-accept-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------- child processes
const children = new Set();

/** Kill a process and everything below it (cmd.exe -> node). */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export function cleanupAll() {
  for (const child of children) killTree(child.pid);
  children.clear();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
}
process.on('exit', cleanupAll);

/** Spawn a long-running process, collecting stdout/stderr. */
export function spawnProc(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.add(child);
  const state = { stdout: '', stderr: '', code: null };
  child.stdout.setEncoding('utf8').on('data', (c) => (state.stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c) => (state.stderr += c));
  const exited = new Promise((resolve) =>
    child.on('exit', (code) => {
      state.code = code;
      resolve(code);
    }),
  );
  return {
    child,
    state,
    exited,
    get stdout() {
      return state.stdout;
    },
    get stderr() {
      return state.stderr;
    },
    waitForLine(re, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          const m = state.stdout.match(re);
          if (m) return resolve(m);
          if (state.code !== null) return reject(new Error(`process exited with ${state.code} before ${re}; stdout: ${state.stdout.trim()} stderr: ${state.stderr.trim()}`));
          if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${re}; stdout: ${state.stdout.trim()} stderr: ${state.stderr.trim()}`));
          setTimeout(tick, 50);
        };
        tick();
      });
    },
    async kill() {
      killTree(child.pid);
      await Promise.race([exited, sleep(3000)]);
      children.delete(child);
    },
  };
}

/** Run a command line (through the shell, so `npm` resolves on Windows) and capture everything. */
export function runShell(commandLine, { cwd = root, env = process.env, timeoutMs = 300000 } = {}) {
  const r = spawnSync(commandLine, { cwd, env, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: stripAnsi(r.stdout ?? ''), stderr: stripAnsi(r.stderr ?? ''), output: stripAnsi(`${r.stdout ?? ''}${r.stderr ?? ''}`), error: r.error };
}

export function runCmd(command, args, { cwd = root, env = process.env, timeoutMs = 60000 } = {}) {
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
}

export function startLocalServer(args, { env = {}, cwd = root } = {}) {
  return spawnProc(process.execPath, [path.join(root, 'server', 'index.js'), ...args], {
    cwd,
    env: { ...process.env, TT_NO_OPEN: '1', ...env },
  });
}

// ---------------------------------------------------------------- misc
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1' }, () => s.close(() => resolve(true)));
  });
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

/** First port >= start such that `count` consecutive ports are free. */
export async function findFreeBase(count, start = 4390) {
  for (let base = start; base < start + 3000; base++) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await isPortFree(base + i);
    if (ok) return base;
  }
  throw new Error('no free port range found');
}

/** Raw HTTP request: the path is sent verbatim (no URL normalisation), body returned as a string. */
export function httpRaw(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const putDoc = (port, name, rev, doc) =>
  httpRaw(port, {
    method: 'PUT',
    path: `/api/docs/${name}`,
    headers: { 'Content-Type': 'application/json', 'X-Tuition-Ticker': '1' },
    body: JSON.stringify({ rev, doc }),
  });

export function ok(detail) {
  return { ok: true, detail };
}
export function fail(detail) {
  return { ok: false, detail };
}

// ---------------------------------------------------------------- memoised heavy runs (shared between phases)
const memoCache = new Map();
export function memo(key, fn) {
  if (!memoCache.has(key)) memoCache.set(key, fn());
  return memoCache.get(key);
}

/** `npm test` (vitest + node:test), run once per acceptance run. */
export const npmTestOnce = () => memo('npm test', () => runShell('npm test'));

/** Vitest results of the whole suite as { file, fullName, status } rows (JSON reporter), run once. */
export function vitestRows() {
  return memo('vitest json', () => {
    const outFile = path.join(makeTempDir('tt-accept-vitest-'), 'results.json');
    const r = runShell(`npx vitest run --reporter=json --outputFile="${outFile}"`);
    if (!fs.existsSync(outFile)) return { error: `vitest produced no JSON output (exit ${r.status}): ${r.output.trim().slice(-300)}`, rows: [] };
    const json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const rows = [];
    for (const file of json.testResults) {
      const rel = path.relative(root, file.name).split(path.sep).join('/');
      for (const t of file.assertionResults) rows.push({ file: rel, fullName: t.fullName, status: t.status });
    }
    return { error: null, rows };
  });
}

/**
 * Check that the Vitest tests in files matching `filePattern` all pass and that each fragment in `required`
 * identifies at least one passed test (by substring of its full name).
 * @returns {{ok: boolean, detail: string}}
 */
export function requireVitest(filePattern, required) {
  const { error, rows } = vitestRows();
  if (error) return fail(error);
  const mine = rows.filter((r) => filePattern.test(r.file));
  if (mine.length === 0) return fail(`no tests found for ${filePattern}`);
  const bad = mine.filter((r) => r.status !== 'passed');
  if (bad.length) return fail(`${bad.length} test(s) not passing, first: ${bad[0].fullName} [${bad[0].status}]`);
  const missing = required.filter((frag) => !mine.some((r) => r.fullName.includes(frag)));
  if (missing.length) return fail(`required test case(s) not found: ${missing.join(' | ')}`);
  return ok(`${mine.length} tests pass; ${required.length} required cases present`);
}
