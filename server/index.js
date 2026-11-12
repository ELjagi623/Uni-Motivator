// Entry point: pick a port, detect an already-running instance, start the HTTP server, open the browser.
//
//   node server/index.js [--port N] [--data-dir DIR] [--no-open] [--no-reuse]
//   env: TT_PORT, TT_DATA_DIR, TT_NO_OPEN=1   (command-line flags win over env)
//
// stdout contract (read by scripts and tests):
//   TUITION_TICKER_URL=http://127.0.0.1:<port>   a new instance is listening
//   ALREADY_RUNNING http://127.0.0.1:<port>      another instance of this app already serves; exit code 0

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createCalendarSync } from './calendar-sync.js';
import { createHandler } from './router.js';
import { openBrowser } from './open-browser.js';

export const DEFAULT_PORT = 4280;
export const PORT_ATTEMPTS = 11; // base port + 10
export const HOST = '127.0.0.1';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');

export function readVersion(root = rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Parse CLI flags + env. Throws Error with a readable message on bad input. */
export function parseArgs(argv, env = {}) {
  const opts = {
    port: env.TT_PORT ? Number(env.TT_PORT) : DEFAULT_PORT,
    dataDir: env.TT_DATA_DIR || path.join(rootDir, 'data'),
    noOpen: env.TT_NO_OPEN === '1',
    noReuse: false,
  };
  const valueOf = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq !== -1 ? arg.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      const v = valueOf(i, flag);
      i += 1;
      return v;
    };
    if (flag === '--port') opts.port = Number(take());
    else if (flag === '--data-dir') opts.dataDir = path.resolve(take());
    else if (flag === '--no-open') opts.noOpen = true;
    else if (flag === '--no-reuse') opts.noReuse = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`invalid port: ${String(opts.port)}`);
  }
  opts.dataDir = path.resolve(opts.dataDir);
  return opts;
}

/**
 * Ask whatever listens on 127.0.0.1:<port> who it is.
 * @returns {Promise<'ours' | 'other' | 'free'>}  'free' only when the connection is refused.
 */
export function probePort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get({ host: HOST, port, path: '/api/health', timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= 4096) chunks.push(c);
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done(json && json.app === 'tuition-ticker' ? 'ours' : 'other');
        } catch {
          done('other');
        }
      });
      res.on('error', () => done('other'));
    });
    req.on('timeout', () => {
      req.destroy();
      done('other');
    });
    req.on('error', (err) => done(err && err.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

/**
 * Start listening on 127.0.0.1:<port> (0 = any free port).
 * @returns {Promise<{server: http.Server, port: number, url: string, close: () => Promise<void>}>}
 */
export function startServer({ port, dataDir, appDir = path.join(rootDir, 'app'), version = readVersion(), syncOptions = {}, startupSync = true }) {
  const store = createStore({ dataDir });
  const sync = createCalendarSync({ store, ...syncOptions });
  let boundPort = port;
  const handler = createHandler({ store, getPort: () => boundPort, appDir, version, sync });
  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: HOST }, () => {
      server.off('error', reject);
      boundPort = server.address().port;
      // Subscriptions: one sync now, then every 6 hours (the timer is unref'd and stopped on close).
      if (startupSync) sync.start();
      resolve({
        server,
        port: boundPort,
        url: `http://${HOST}:${boundPort}`,
        sync,
        close: () =>
          new Promise((res) => {
            sync.stop();
            server.close(() => res());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/**
 * Walk base port .. base+10: reuse a running instance of this app, otherwise start on the first free port.
 * @returns {Promise<{kind: 'started', instance: object} | {kind: 'already-running', url: string}>}
 */
export async function startOrReuse(opts, deps = {}) {
  const probe = deps.probePort ?? probePort;
  const start = deps.startServer ?? startServer;
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const port = opts.port + i;
    if (port > 65535) break;
    const who = await probe(port);
    if (who === 'ours' && !opts.noReuse) return { kind: 'already-running', url: `http://${HOST}:${port}` };
    if (who !== 'free') continue; // something else (or another instance we must not reuse) is there
    try {
      return { kind: 'started', instance: await start({ port, dataDir: opts.dataDir }) };
    } catch (err) {
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) continue;
      throw err;
    }
  }
  throw new Error(`no free port in ${opts.port}-${opts.port + PORT_ATTEMPTS - 1}`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = await startOrReuse(opts);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (result.kind === 'already-running') {
    console.log(`ALREADY_RUNNING ${result.url}`);
    if (!opts.noOpen) openBrowser(result.url, { onError: () => {} });
    process.exitCode = 0;
    return;
  }

  const { instance } = result;
  console.log(`TUITION_TICKER_URL=${instance.url}`);
  console.log(`Data directory: ${opts.dataDir}`);
  if (!opts.noOpen) {
    openBrowser(instance.url, {
      onError: (err) => console.error(`Could not open the browser automatically (${err.message}). Open ${instance.url} manually.`),
    });
  }
  const shutdown = () => {
    instance.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
