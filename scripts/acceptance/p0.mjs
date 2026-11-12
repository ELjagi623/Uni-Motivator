// P0 acceptance checks (project skeleton and launcher). Standard numbers match .pipeline/PLAN.md: P0.1 ... P0.6.
// P0.6 only automates the data-interface half; the browser half is listed in the dev report as "not covered".

import fs from 'node:fs';
import path from 'node:path';
import {
  root,
  isWindows,
  makeTempDir,
  runCmd,
  runShell,
  npmTestOnce,
  spawnProc,
  startLocalServer,
  findFreeBase,
  isListening,
  httpRaw,
  putDoc,
  killTree,
  ok,
  fail,
} from './lib.mjs';
import http from 'node:http';

const git = (...args) => runCmd('git', args);

// ------------------------------------------------------------------ P0.1
async function p01() {
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return fail('not inside a git work tree');

  const probes = ['.pipeline/x', 'node_modules/x', 'app/x', 'data/x', 'test-data/private/x', 'coverage/x', 'release/x'];
  const notIgnored = probes.filter((p) => git('check-ignore', '-q', p).status !== 0);
  if (notIgnored.length) return fail(`not ignored: ${notIgnored.join(', ')}`);

  if (git('check-ignore', '-q', 'package-lock.json').status === 0) return fail('package-lock.json is ignored');
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) return fail('package-lock.json does not exist');

  const status = git('status', '--porcelain', '-uall');
  if (status.status !== 0) return fail(`git status failed: ${status.stderr.trim()}`);
  const leaked = status.stdout.split('\n').filter((l) => /(^|[\s"/])\.pipeline\//.test(l) || /test-data\/private/.test(l));
  if (leaked.length) return fail(`${leaked.length} path(s) under .pipeline/ or test-data/private/ show up in git status`);

  return ok('in work tree; 7 paths ignored; package-lock.json tracked-able; .pipeline/ and test-data/private/ absent from git status');
}

// ------------------------------------------------------------------ P0.2
async function p02() {
  const build = runShell('npm run build');
  if (build.status !== 0) return fail(`npm run build failed: ${build.output.trim().split('\n').slice(-5).join(' | ')}`);
  const indexPath = path.join(root, 'app', 'index.html');
  if (!fs.existsSync(indexPath)) return fail('app/index.html missing after build');
  const indexText = fs.readFileSync(indexPath, 'utf8');
  const pkgText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

  const base = await findFreeBase(1, 4390);
  const dataDir = makeTempDir();
  const srv = startLocalServer(['--no-open', '--port', String(base), '--data-dir', dataDir]);
  try {
    await srv.waitForLine(/TUITION_TICKER_URL=/);
    const problems = [];
    for (const p of ['/', '/some/spa/path']) {
      const r = await httpRaw(base, { path: p });
      if (r.status !== 200) problems.push(`${p} -> ${r.status}`);
      else if (r.text !== indexText) problems.push(`${p} body is not index.html`);
    }
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json']) {
      const r = await httpRaw(base, { path: p });
      if (![403, 404].includes(r.status)) problems.push(`${p} -> ${r.status} (expected 403/404)`);
      if (r.text.includes('"name": "tuition-ticker"') || r.text === pkgText) problems.push(`${p} leaked package.json`);
    }
    if (problems.length) return fail(problems.join('; '));
    return ok('build ok; / and SPA path -> 200 index.html; both traversal attempts rejected (403/404) without leaking package.json');
  } finally {
    await srv.kill();
  }
}

// ------------------------------------------------------------------ P0.3
const REQUIRED_TESTS = [
  ['atomic write (no half file)', 'leaves the original file intact and no .tmp file behind when writing fails midway'],
  ['backup rotation (25 writes -> 20)', 'keeps at most 20 backups per document after 25 writes'],
  ['rev conflict -> 409', 'returns 409 with the server copy when rev does not match'],
  ['bad Host rejected', 'rejects a foreign Host header with 403'],
  ['missing X-Tuition-Ticker rejected', 'rejects write requests without the X-Tuition-Ticker header'],
  ['> 5 MB -> 413', 'rejects request bodies above 5 MB with 413'],
  ['PUT /api/docs/evil -> 404', 'returns 404 for a document name outside config|marks|slacks'],
];

async function p03() {
  const test = npmTestOnce();
  if (test.status !== 0) {
    const failing = test.output.split('\n').filter((l) => /^\s*(✖|×)/.test(l)).slice(0, 5).join(' | ');
    return fail(`npm test exited ${test.status}${failing ? `: ${failing}` : ''}`);
  }
  const passedLines = test.output.split('\n').filter((l) => /^\s*[✔✓]/.test(l));
  const missing = REQUIRED_TESTS.filter(([, needle]) => !passedLines.some((l) => l.includes(needle))).map(([label]) => label);
  if (missing.length) return fail(`required test case(s) not seen passing in npm test output: ${missing.join('; ')}`);

  const arch = runShell('npm run check:arch');
  if (arch.status !== 0) return fail(`check:arch exited ${arch.status}: ${arch.output.trim().split('\n').slice(-3).join(' | ')}`);
  if (!/zero third-party imports: yes/.test(arch.output)) return fail('check:arch did not report "zero third-party imports: yes"');

  const summary = (test.output.match(/ℹ pass (\d+)/) ?? [])[1];
  return ok(`npm test passed (${summary ?? '?'} node:test cases + vitest); all ${REQUIRED_TESTS.length} required cases seen; check:arch OK, server/ has zero third-party imports`);
}

// ------------------------------------------------------------------ P0.4
function buildEnv(overrides, { replacePath } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (replacePath && k.toUpperCase() === 'PATH') continue;
    env[k] = v;
  }
  if (replacePath) env.Path = replacePath;
  return { ...env, ...overrides };
}

async function p04() {
  if (!isWindows) return ok('skipped: start.cmd is Windows-only');

  // 1. byte-level checks on start.cmd
  const bytes = fs.readFileSync(path.join(root, 'start.cmd'));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return fail('start.cmd has a UTF-8 BOM');
  if (bytes.some((b) => b > 127)) return fail('start.cmd contains non-ASCII bytes (cmd.exe garbles multi-byte text in batch files; put Chinese in server/messages/*.txt)');
  for (const f of ['no-node', 'old-node', 'first-run', 'no-npm', 'install-failed', 'build-failed', 'starting', 'server-failed']) {
    const mp = path.join(root, 'server', 'messages', `${f}.txt`);
    if (!fs.existsSync(mp)) return fail(`missing launcher message file server/messages/${f}.txt`);
    const mb = fs.readFileSync(mp);
    if (mb[0] === 0xef && mb[1] === 0xbb) return fail(`server/messages/${f}.txt has a BOM`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('start.cmd is not valid UTF-8');
  }
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const cr = (text.match(/\r/g) ?? []).length;
  if (lf === 0 || lf !== crlf || cr !== crlf) return fail(`start.cmd line endings are not pure CRLF (LF=${lf}, CRLF=${crlf}, CR=${cr})`);
  const head = text.split('\r\n').slice(0, 5).join('\n');
  if (!/chcp\s+65001/i.test(head)) return fail('chcp 65001 not found near the top of start.cmd');

  // 2. copy the project into "...\学费 test dir\" (spaces + Chinese) without node_modules/data/test-data/.pipeline
  const base = makeTempDir();
  const copyDir = path.join(base, '学费 test dir');
  const skip = new Set(['node_modules', 'data', 'test-data', '.pipeline', '.git', 'coverage', 'release']);
  fs.cpSync(root, copyDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      return rel === '' || !skip.has(rel.split(path.sep)[0]);
    },
  });
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

  // 2a. normal start -> /api/health
  const port = await findFreeBase(1, 4390);
  const dataDir = path.join(base, 'data dir');
  // `.\start.cmd` rather than bare `start.cmd`: cmd ignores the current directory for bare names when
  // NoDefaultCurrentDirectoryInExePath is set (as in some CI / agent shells).
  const run = spawnProc(comspec, ['/d', '/c', '.\\start.cmd'], {
    cwd: copyDir,
    env: buildEnv({ TT_NO_OPEN: '1', TT_PORT: String(port), TT_DATA_DIR: dataDir }),
  });
  try {
    await run.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/, 90000);
    const health = await httpRaw(port, { path: '/api/health' });
    if (health.json?.app !== 'tuition-ticker') return fail(`start.cmd in a spaced/Chinese path: /api/health returned ${health.text.slice(0, 80)}`);
  } catch (err) {
    return fail(`start.cmd did not start the server in "${copyDir}": ${err.message}`);
  } finally {
    killTree(run.child.pid);
  }

  // 2b. no node on PATH -> Chinese hint, non-zero exit, no web page opened (TT_NO_OPEN=1)
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const minimalPath = path.join(sysRoot, 'System32');
  const noNode = runCmd(comspec, ['/d', '/c', '.\\start.cmd'], {
    cwd: copyDir,
    env: buildEnv({ TT_NO_OPEN: '1' }, { replacePath: minimalPath }),
    timeoutMs: 30000,
  });
  if (noNode.error) return fail(`running start.cmd without node failed to execute: ${noNode.error.message}`);
  if (noNode.status === 0 || noNode.status === null) return fail(`start.cmd without node exited with ${noNode.status} (expected non-zero)`);
  if (!/Node\.js/.test(noNode.output) || !/https:\/\/nodejs\.org/.test(noNode.output)) {
    return fail(`start.cmd without node: output lacks "Node.js" / https://nodejs.org (got: ${noNode.output.trim().slice(0, 120)})`);
  }
  if (!noNode.output.includes('\u6ca1\u6709\u627e\u5230 Node.js')) return fail('start.cmd without node: the Chinese hint "\u6ca1\u6709\u627e\u5230 Node.js" is missing or garbled');
  if (/is not recognized/.test(noNode.output)) return fail(`start.cmd without node: cmd reported a mangled command: ${noNode.output.trim().slice(0, 160)}`);

  return ok(`start.cmd: ASCII-only, no BOM, pure CRLF, chcp 65001 present; runs from a spaced+Chinese path (/api/health ok); without node on PATH exits ${noNode.status} with a Chinese hint naming Node.js and https://nodejs.org`);
}

// ------------------------------------------------------------------ P0.5
async function p05() {
  const base = await findFreeBase(2, 4390);
  const dataDir = makeTempDir();
  const a = startLocalServer(['--port', String(base), '--no-open', '--data-dir', dataDir]);
  try {
    await a.waitForLine(/TUITION_TICKER_URL=/);
    const second = runCmd(process.execPath, [path.join(root, 'server', 'index.js'), '--port', String(base), '--no-open', '--data-dir', dataDir], {
      env: { ...process.env, TT_NO_OPEN: '1' },
      timeoutMs: 20000,
    });
    if (second.status !== 0) return fail(`second run exited ${second.status} (expected 0): ${second.output.trim()}`);
    if (!second.stdout.includes(`ALREADY_RUNNING http://127.0.0.1:${base}`)) return fail(`second run did not print ALREADY_RUNNING http://127.0.0.1:${base}: ${second.stdout.trim()}`);
    if (await isListening(base + 1)) return fail(`a second server is listening on ${base + 1}`);
  } finally {
    await a.kill();
  }

  // Port taken by a program that is not Tuition Ticker -> next port.
  const q = await findFreeBase(2, base + 10);
  const dummy = http.createServer((req, res) => res.end('not tuition ticker'));
  await new Promise((r) => dummy.listen(q, '127.0.0.1', r));
  const b = startLocalServer(['--port', String(q), '--no-open', '--data-dir', dataDir]);
  try {
    const m = await b.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/);
    const got = Number(m[1]);
    if (got !== q + 1) return fail(`with ${q} occupied the new instance chose port ${got} (expected ${q + 1})`);
    const health = await httpRaw(got, { path: '/api/health' });
    if (health.json?.app !== 'tuition-ticker') return fail('new instance on the fallback port does not answer /api/health');
  } finally {
    await b.kill();
    await new Promise((r) => {
      dummy.close(r);
      dummy.closeAllConnections?.();
    });
  }
  return ok(`second run on ${base}: ALREADY_RUNNING, exit 0, nothing on ${base + 1}; with ${q} held by another program the new instance used ${q + 1} and answers /api/health`);
}

// ------------------------------------------------------------------ P0.6 (data-interface half)
async function p06() {
  const base = await findFreeBase(1, 4390);
  const dataDir = makeTempDir();
  const args = ['--port', String(base), '--no-open', '--data-dir', dataDir];

  const s1 = startLocalServer(args);
  let before;
  try {
    await s1.waitForLine(/TUITION_TICKER_URL=/);
    const w1 = await putDoc(base, 'config', 0, { note: 'first', tuitionMinor: 39800000 });
    const w2 = await putDoc(base, 'config', 1, { note: 'second', tuitionMinor: 39800000 });
    if (w1.json?.rev !== 1 || w2.json?.rev !== 2) return fail(`PUT revs were ${w1.json?.rev}, ${w2.json?.rev} (expected 1, 2)`);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    if (file.schemaVersion !== 1 || file.rev !== 2) return fail(`data/config.json has schemaVersion=${file.schemaVersion} rev=${file.rev}`);
    const backups = fs.existsSync(path.join(dataDir, 'backups')) ? fs.readdirSync(path.join(dataDir, 'backups')) : [];
    if (!backups.some((f) => /^\d{8}-\d{6}-\d{3}_config\.json$/.test(f))) return fail('no backups/*_config.json after the second write');
    before = (await httpRaw(base, { path: '/api/data' })).json;
  } finally {
    await s1.kill();
  }

  const s2 = startLocalServer(args);
  try {
    await s2.waitForLine(/TUITION_TICKER_URL=/);
    const after = (await httpRaw(base, { path: '/api/data' })).json;
    if (JSON.stringify(after) !== JSON.stringify(before)) return fail('GET /api/data differs after restarting the server');
    if (after.config.note !== 'second') return fail('config.note not preserved across restart');
  } finally {
    await s2.kill();
  }
  return ok('data/config.json has schemaVersion + rev 2; backups/*_config.json created; GET /api/data identical after restart (browser half: see dev report)');
}

export const checks = [
  { id: 'P0.1', title: 'git repo and ignore rules', run: p01 },
  { id: 'P0.2', title: 'build and static hosting, traversal blocked', run: p02 },
  { id: 'P0.3', title: 'npm test (server cases) and check:arch', run: p03 },
  { id: 'P0.4', title: 'start.cmd in spaced/Chinese path; no-Node hint; CRLF/no BOM', run: p04 },
  { id: 'P0.5', title: 'single instance and automatic port change', run: p05 },
  { id: 'P0.6', title: 'persistence and backups (data-interface half)', run: p06 },
];
