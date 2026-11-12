import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { parseArgs, probePort, startOrReuse, DEFAULT_PORT } from '../../server/index.js';
import { getOpenCommand, openBrowser } from '../../server/open-browser.js';
import { findFreePorts, isListening, makeTempDir, removeDir, request, spawnServer } from './helpers.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

describe('parseArgs', () => {
  it('uses defaults', () => {
    const o = parseArgs([], {});
    assert.equal(o.port, DEFAULT_PORT);
    assert.equal(o.noOpen, false);
    assert.equal(o.noReuse, false);
    assert.ok(path.isAbsolute(o.dataDir));
    assert.equal(path.basename(o.dataDir), 'data');
  });

  it('reads env vars and lets flags override them', () => {
    const env = { TT_PORT: '4500', TT_DATA_DIR: 'envdata', TT_NO_OPEN: '1' };
    const a = parseArgs([], env);
    assert.equal(a.port, 4500);
    assert.equal(a.noOpen, true);
    assert.equal(a.dataDir, path.resolve('envdata'));
    const b = parseArgs(['--port', '4600', '--data-dir', 'flagdata'], env);
    assert.equal(b.port, 4600);
    assert.equal(b.dataDir, path.resolve('flagdata'));
  });

  it('accepts --flag=value and --no-open / --no-reuse', () => {
    const o = parseArgs(['--port=4700', '--data-dir=x', '--no-open', '--no-reuse'], {});
    assert.equal(o.port, 4700);
    assert.equal(o.noOpen, true);
    assert.equal(o.noReuse, true);
  });

  it('rejects bad input', () => {
    assert.throws(() => parseArgs(['--port', 'abc'], {}), /invalid port/);
    assert.throws(() => parseArgs(['--port', '70000'], {}), /invalid port/);
    assert.throws(() => parseArgs(['--port'], {}), /needs a value/);
    assert.throws(() => parseArgs(['--bogus'], {}), /unknown option/);
  });
});

describe('open-browser', () => {
  it('builds the platform specific command', () => {
    const win = getOpenCommand('http://127.0.0.1:4280', 'win32');
    assert.equal(win.command, 'cmd');
    assert.deepEqual(win.args, ['/c', 'start', '""', 'http://127.0.0.1:4280']);
    assert.deepEqual(getOpenCommand('http://x', 'darwin'), { command: 'open', args: ['http://x'], options: {} });
    assert.deepEqual(getOpenCommand('http://x', 'linux'), { command: 'xdg-open', args: ['http://x'], options: {} });
  });

  it('never throws when spawning fails', () => {
    const errors = [];
    const ok = openBrowser('http://x', {
      spawnFn() {
        throw new Error('no such command');
      },
      onError: (e) => errors.push(e.message),
    });
    assert.equal(ok, false);
    assert.deepEqual(errors, ['no such command']);
  });
});

describe('single instance and port selection', () => {
  it('prints ALREADY_RUNNING and exits 0 when this app already runs on the port, without a second server', async () => {
    const base = await findFreePorts(3);
    const dataDir = makeTempDir();
    cleanups.push(() => removeDir(dataDir));
    const a = spawnServer(['--port', String(base), '--data-dir', dataDir, '--no-open']);
    cleanups.push(() => a.stop());
    await a.waitForLine(/^TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/m);
    assert.match(a.stdout, new RegExp(`TUITION_TICKER_URL=http://127.0.0.1:${base}\\b`));

    const b = spawnServer(['--port', String(base), '--data-dir', dataDir, '--no-open']);
    const code = await b.exited;
    assert.equal(code, 0);
    assert.match(b.stdout, new RegExp(`ALREADY_RUNNING http://127\\.0\\.0\\.1:${base}\\b`));
    assert.doesNotMatch(b.stdout, /TUITION_TICKER_URL/);
    assert.equal(await isListening(base + 1), false);
  });

  it('moves on to the next port when the base port is taken by another program', async () => {
    const base = await findFreePorts(3);
    const dummy = http.createServer((req, res) => res.end('i am not tuition ticker'));
    await new Promise((r) => dummy.listen(base, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => dummy.close(r)));
    const dataDir = makeTempDir();
    cleanups.push(() => removeDir(dataDir));

    const p = spawnServer(['--port', String(base), '--data-dir', dataDir, '--no-open']);
    cleanups.push(() => p.stop());
    const m = await p.waitForLine(/^TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/m);
    assert.equal(Number(m[1]), base + 1);
    const health = await request(Number(m[1]), { path: '/api/health' });
    assert.equal(health.json.app, 'tuition-ticker');
  });

  it('probePort classifies a silent listener as taken and a closed port as free', async () => {
    const base = await findFreePorts(4);
    const sockets = new Set();
    const silent = net.createServer((sock) => sockets.add(sock)); // accepts, never replies
    await new Promise((r) => silent.listen(base, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise((r) => {
          silent.close(r);
          for (const sock of sockets) sock.destroy();
        }),
    );
    assert.equal(await probePort(base, 200), 'other');
    assert.equal(await probePort(base + 1, 200), 'free');
  });

  it('startOrReuse: --no-reuse starts a second instance on the next port', async () => {
    const base = await findFreePorts(3);
    const dataDir = makeTempDir();
    cleanups.push(() => removeDir(dataDir));
    const first = await startOrReuse({ port: base, dataDir, noReuse: false });
    cleanups.push(() => first.instance.close());
    assert.equal(first.kind, 'started');
    const reuse = await startOrReuse({ port: base, dataDir, noReuse: false });
    assert.deepEqual(reuse, { kind: 'already-running', url: `http://127.0.0.1:${base}` });
    const second = await startOrReuse({ port: base, dataDir, noReuse: true });
    cleanups.push(() => second.instance.close());
    assert.equal(second.kind, 'started');
    assert.equal(second.instance.port, base + 1);
  });

  it('startOrReuse: gives up after base+10', async () => {
    const deps = { probePort: async () => 'other', startServer: async () => assert.fail('must not start') };
    await assert.rejects(() => startOrReuse({ port: 4280, dataDir: 'x', noReuse: false }, deps), /no free port in 4280-4290/);
  });

  it('exits with a non-zero code on invalid arguments', async () => {
    const p = spawnServer(['--port', 'nope']);
    assert.notEqual(await p.exited, 0);
    assert.match(p.stderr, /invalid port/);
  });
});

describe('persistence across restarts', () => {
  it('keeps documents after the server process is restarted on the same data dir', async () => {
    const base = await findFreePorts(2);
    const dataDir = makeTempDir();
    cleanups.push(() => removeDir(dataDir));

    const run1 = spawnServer(['--port', String(base), '--data-dir', dataDir, '--no-open']);
    await run1.waitForLine(/TUITION_TICKER_URL=/);
    const w1 = await request(base, { method: 'PUT', path: '/api/docs/config', write: true, json: { rev: 0, doc: { note: 'persist me' } } });
    assert.equal(w1.status, 200);
    const w2 = await request(base, { method: 'PUT', path: '/api/docs/config', write: true, json: { rev: 1, doc: { note: 'persist me v2' } } });
    assert.equal(w2.json.rev, 2);
    await run1.stop();

    const run2 = spawnServer(['--port', String(base), '--data-dir', dataDir, '--no-open']);
    cleanups.push(() => run2.stop());
    await run2.waitForLine(/TUITION_TICKER_URL=/);
    const data = await request(base, { path: '/api/data' });
    assert.equal(data.json.config.note, 'persist me v2');
    assert.equal(data.json.config.rev, 2);
  });
});
