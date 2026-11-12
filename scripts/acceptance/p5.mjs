// P5 acceptance checks (open-source release: docs, launcher scripts, release zip, fresh-folder run, workflow, regression).
// Standard numbers match .pipeline/PLAN.md: P5.1 ... P5.5. P5.6 (compatibility smoke in a browser) is not automated.
//
// Nothing here pushes, tags, publishes or runs GitHub Actions: the zip is only written to the git-ignored release/ folder.
// Privacy: if a private calendar exists under test-data/private it is only read in memory, to prove that none of its event
// titles leaked into docs, the sample or the release zip. Only PASS / FAIL is printed, never any title.

import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { root, isWindows, findFreeBase, httpRaw, killTree, makeTempDir, memo, npmTestOnce, ok, fail, runCmd, runShell, spawnProc, startLocalServer } from './lib.mjs';

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
const git = (...args) => runCmd('git', args);

// ---------------------------------------------------------------- private-calendar leak guard
function addTitles(text, titles) {
  for (const m of text.matchAll(/^SUMMARY[^:\r\n]*:(.+)$/gim)) if (m[1].trim().length >= 8) titles.add(m[1].trim());
}

/** Event titles (>= 8 characters) of any real calendar in test-data/private, held in memory only. */
function privateTitles() {
  const dir = path.join(root, 'test-data', 'private');
  const titles = new Set();
  if (!fs.existsSync(dir)) return titles;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.ics')) addTitles(fs.readFileSync(p, 'utf8'), titles);
      else if (e.name.toLowerCase().endsWith('.zip')) {
        // a Google Calendar export: read the .ics files inside it, in memory
        for (const [name, data] of Object.entries(unzipSync(new Uint8Array(fs.readFileSync(p))))) if (name.toLowerCase().endsWith('.ics')) addTitles(Buffer.from(data).toString('utf8'), titles);
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable: nothing to guard */
  }
  return titles;
}
const leaks = (text, titles) => [...titles].filter((t) => text.includes(t)).length;

// ---------------------------------------------------------------- zip reading (central directory, with external attributes)
export function readZipDirectory(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const hostOs = buf[p + 5];
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    entries.push({ name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'), hostOs, mode: hostOs === 3 ? external >>> 16 : null });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ------------------------------------------------------------------ P5.1
const LINK = /\]\(([^)\s]+)\)/g;

async function p51() {
  const problems = [];
  // start.command
  const cmdBytes = fs.readFileSync(path.join(root, 'start.command'));
  const cmdText = cmdBytes.toString('utf8');
  if (cmdBytes.includes(0x0d)) problems.push('start.command contains CR bytes (must be LF only)');
  if (cmdBytes[0] === 0xef) problems.push('start.command has a BOM');
  if (cmdText.split('\n')[0] !== '#!/bin/bash') problems.push('start.command: first line is not #!/bin/bash');
  if (!/process\.versions\.node\.split\('\.'\)\[0\] >= 22/.test(cmdText)) problems.push('start.command: no Node >= 22 check');
  if (!/command -v node/.test(cmdText)) problems.push('start.command: no check that node exists');
  if (!/node server\/index\.js/.test(cmdText)) problems.push('start.command does not run node server/index.js');
  if (!/cd "\$\(dirname "\$0"\)"/.test(cmdText)) problems.push('start.command does not cd to its own folder');
  if (!/app\/index\.html/.test(cmdText)) problems.push('start.command: no build-when-app-is-missing logic');
  if (!/open "https:\/\/nodejs\.org\/"/.test(cmdText)) problems.push('start.command does not use `open` to show the Node.js page');
  const bash = runCmd('bash', ['-n', 'start.command']);
  let bashNote = 'bash -n: no syntax errors';
  if (bash.error) bashNote = 'bash not available here: syntax not checked';
  else if (bash.status !== 0) problems.push(`bash -n start.command failed: ${bash.stderr.trim().slice(0, 120)}`);
  if (!/\*\.command text eol=lf/.test(read('.gitattributes'))) problems.push('.gitattributes does not force LF for *.command');
  // start.cmd stays ASCII + CRLF (P0.4 checks it in depth; repeated here because the zip ships it)
  const winBytes = fs.readFileSync(path.join(root, 'start.cmd'));
  if (winBytes.some((b) => b > 127)) problems.push('start.cmd is not ASCII-only');
  if (winBytes.toString('latin1').split('\n').some((l, i, a) => i < a.length - 1 && !l.endsWith('\r'))) problems.push('start.cmd is not pure CRLF');

  // LICENSE
  const lic = read('LICENSE').split(/\s+/).join(' '); // the licence text is line-wrapped
  for (const needle of ['MIT License', 'Permission is hereby granted, free of charge', 'The above copyright notice and this permission notice shall be included', 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND', 'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE', 'Tuition Ticker contributors']) {
    if (!lic.includes(needle)) problems.push(`LICENSE lacks: ${needle.slice(0, 40)}`);
  }

  // READMEs
  const spec = {
    'README.md': { other: 'README.zh-CN.md', parts: ['Quick start', 'Google Calendar', 'Privacy', 'FAQ', 'right-click', 'docs/images/dashboard.png', 'docs/images/slacking.png', 'Backup', 'not been reviewed by native', 'firewall', 'port', 'Node.js', 'system clock', 'Portable'] },
    'README.zh-CN.md': { other: 'README.md', parts: ['快速开始', 'Google', '隐私', '常见问题', '右键', 'docs/images/dashboard.png', 'docs/images/slacking.png', '备份', '未经母语者校对', '防火墙', '端口', 'Node.js', '系统时间', '免安装版'] },
  };
  const docFiles = ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'docs/COMPAT.md'];
  for (const [file, { other, parts }] of Object.entries(spec)) {
    const text = read(file);
    for (const part of parts) if (!text.toLowerCase().includes(part.toLowerCase())) problems.push(`${file} lacks "${part}"`);
    if (!new RegExp(`\\]\\(${other.replace('.', '\\.')}\\)`).test(text)) problems.push(`${file} does not link to ${other}`);
    if (!/!\[[^\]]*\]\(docs\/images\/dashboard\.png\)/.test(text) || !/!\[[^\]]*\]\(docs\/images\/slacking\.png\)/.test(text)) problems.push(`${file} lacks a screenshot image`);
  }
  for (const file of docFiles) {
    for (const m of read(file).matchAll(LINK)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (clean && !exists(path.join(path.dirname(file), clean).split(path.sep).join('/'))) problems.push(`${file}: broken relative link ${target}`);
    }
  }
  for (const shot of ['dashboard.png', 'slacking.png']) {
    if (!fs.readFileSync(path.join(root, 'docs', 'images', shot)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) problems.push(`docs/images/${shot} is not a PNG`);
  }

  // CONTRIBUTING covers school presets, price packs, translations, copy lines
  const contrib = read('CONTRIBUTING.md');
  for (const part of ['Add a school / region preset', 'Add a city price pack', 'Add or improve a translation', 'copy lines']) if (!contrib.includes(part)) problems.push(`CONTRIBUTING.md lacks "${part}"`);

  // sample calendar: parsed by core, used by the demo mode
  const sample = runShell('npx tsx scripts/acceptance/p5-sample.ts');
  let sampleNote = '';
  if (sample.status !== 0) problems.push(`sample calendar could not be parsed: ${sample.output.trim().slice(-120)}`);
  else {
    const info = JSON.parse(sample.stdout.trim().split('\n').at(-1));
    if (info.sessions < 10) problems.push(`sample calendar has only ${info.sessions} classes`);
    sampleNote = `sample calendar: ${info.sessions} classes, ${info.suggestedCourses} suggested courses`;
  }
  if (!/examples\/sample-calendar\.ics/.test(read('src/state/demo.ts'))) problems.push('the demo mode does not use examples/sample-calendar.ics');
  if (!/demo/i.test(read('README.md'))) problems.push('README does not mention the demo');

  // no personal data, no real calendar content
  const titles = privateTitles();
  let leaked = 0;
  for (const file of [...docFiles, 'LICENSE', 'examples/sample-calendar.ics', 'start.command', 'start.cmd']) {
    const text = read(file);
    leaked += leaks(text, titles);
    if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text) && file !== 'examples/sample-calendar.ics') problems.push(`${file} contains something that looks like an e-mail address`);
    if (/test-data[\\/]private/.test(text) && file !== 'CONTRIBUTING.md' && !file.startsWith('docs/')) problems.push(`${file} mentions test-data/private`);
  }
  if (leaked) problems.push(`${leaked} event title(s) of the private calendar appear in docs / sample / scripts`);
  if (problems.length) return fail(problems.slice(0, 5).join('; '));
  return ok(`start.command: LF, #!/bin/bash, ${bashNote}, Node >= 22 check, cd to own folder, builds only when app/index.html is missing, runs node server/index.js, uses \`open\`; start.cmd ASCII + CRLF; LICENSE is the full MIT text (Tuition Ticker contributors); README.md and README.zh-CN.md cover screenshot, three steps, Google export, privacy, FAQ, macOS first open, backup, subscription note, translation note, link each other, all relative links resolve; CONTRIBUTING.md covers presets / price packs / translations / copy; ${sampleNote}, used by the demo mode; no e-mail address and no private-calendar title in any doc${titles.size ? ' (private calendar present: checked in memory, nothing printed)' : ''}`);
}

// ------------------------------------------------------------------ P5.2 (release zip)
const FORBIDDEN = [/^data\//, /^test-data\//, /^\.pipeline\//, /^node_modules\//, /^src\//, /^tests\//, /^\.git/, /^release\//, /^coverage\//, /^docs\//, /^examples\//, /^scripts\//, /\.ics$/i, /\.map$/];
const TOP_FILES = ['start.cmd', 'start.command', 'package.json', 'README.md', 'README.zh-CN.md', 'LICENSE'];

const buildRelease = () =>
  memo('release', () => {
    const r = runShell('npm run release', { timeoutMs: 400000 });
    const m = /RELEASE_ZIP=(.+)/.exec(r.stdout);
    return { status: r.status, output: r.output, zip: m ? m[1].trim() : null };
  });

async function p52() {
  const rel = buildRelease();
  if (rel.status !== 0 || !rel.zip) return fail(`npm run release failed: ${rel.output.trim().slice(-200)}`);
  const pkg = JSON.parse(read('package.json'));
  const expectedName = `tuition-ticker-v${pkg.version}.zip`;
  if (path.basename(rel.zip) !== expectedName) return fail(`zip is ${path.basename(rel.zip)}, expected ${expectedName}`);
  if (!fs.existsSync(rel.zip)) return fail('the zip was not written');
  const buf = fs.readFileSync(rel.zip);
  const entries = readZipDirectory(buf);
  const names = entries.map((e) => e.name);
  const problems = [];
  for (const f of TOP_FILES) if (!names.includes(f)) problems.push(`missing ${f}`);
  if (!names.includes('app/index.html')) problems.push('missing app/index.html');
  const stray = names.filter((n) => !TOP_FILES.includes(n) && !n.startsWith('server/') && !n.startsWith('app/'));
  if (stray.length) problems.push(`entries outside the whitelist: ${stray.slice(0, 3).join(', ')}`);
  const forbidden = names.filter((n) => FORBIDDEN.some((re) => re.test(n)));
  if (forbidden.length) problems.push(`forbidden entries: ${forbidden.slice(0, 3).join(', ')}`);
  if (names.some((n) => n.endsWith('/'))) problems.push('the zip holds directory entries');
  if (new Set(names).size !== names.length) problems.push('duplicate entries');
  // every server file is shipped
  const serverFiles = fs.readdirSync(path.join(root, 'server'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(path.join(root, 'server'), path.join(e.parentPath, e.name)).split(path.sep).join('/'));
  for (const f of serverFiles) if (!names.includes(`server/${f}`)) problems.push(`server/${f} is not in the zip`);
  // modes: start.command executable, everything else not
  const cmd = entries.find((e) => e.name === 'start.command');
  if (!cmd || cmd.hostOs !== 3 || (cmd.mode & 0o111) !== 0o111) problems.push(`start.command is not executable in the zip (mode ${cmd?.mode?.toString(8)})`);
  const other = entries.filter((e) => e.name !== 'start.command' && e.mode !== null && (e.mode & 0o111) !== 0);
  if (other.length) problems.push(`other entries are executable: ${other[0].name}`);
  // contents: line endings survive, the app is the freshly built one
  const files = unzipSync(new Uint8Array(buf));
  const bytes = (n) => Buffer.from(files[n] ?? []);
  if (bytes('start.command').includes(0x0d)) problems.push('start.command in the zip has CR bytes');
  if (!bytes('start.cmd').equals(fs.readFileSync(path.join(root, 'start.cmd')))) problems.push('start.cmd in the zip differs from the source file');
  if (!bytes('app/index.html').equals(fs.readFileSync(path.join(root, 'app', 'index.html')))) problems.push('app/index.html in the zip is not the built one');
  // no private calendar content anywhere in the zip
  const titles = privateTitles();
  let leaked = 0;
  for (const [n, data] of Object.entries(files)) leaked += leaks(Buffer.from(data).toString('utf8'), titles);
  if (leaked) problems.push(`${leaked} private-calendar title(s) found inside the zip`);
  if (git('check-ignore', '-q', `release/${expectedName}`).status !== 0) problems.push('release/ is not ignored by git');
  if (problems.length) return fail(problems.slice(0, 5).join('; '));
  return ok(`release/${expectedName}: ${names.length} entries, exactly the whitelist (start.cmd, start.command, package.json, README.md, README.zh-CN.md, LICENSE, server/ with all ${serverFiles.length} files, app/); none of data/ test-data/ .pipeline/ node_modules/ src/ tests/ .git or any .ics; start.command is mode ${cmd.mode.toString(8)} (Unix, executable) and nothing else is executable; start.cmd bytes identical (CRLF kept), start.command LF; release/ is git-ignored${titles.size ? '; private calendar present: none of its titles are in the zip' : ''}`);
}

// ------------------------------------------------------------------ P5.3 (fresh folder)
function extractZip(zipPath, dest) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  for (const [name, data] of Object.entries(files)) {
    const target = path.join(dest, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

async function checkServedAssets(port) {
  const index = await httpRaw(port, { path: '/' });
  if (index.status !== 200 || !/<div id="app">/.test(index.text)) return `GET / -> ${index.status}`;
  const urls = [...index.text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  if (urls.length < 2) return 'index.html references fewer than 2 assets';
  const css = urls.filter((u) => u.endsWith('.css'));
  const all = new Set(urls);
  for (const c of css) {
    const res = await httpRaw(port, { path: c });
    for (const m of res.text.matchAll(/url\(["']?(\/?[^)"']+\.woff2?)["']?\)/g)) all.add(m[1].startsWith('/') ? m[1] : `/${m[1]}`);
  }
  const bad = [];
  for (const u of all) {
    const r = await httpRaw(port, { path: u });
    if (r.status !== 200 || r.text.length === 0) bad.push(`${u} -> ${r.status}`);
  }
  if (!all.size || [...all].filter((u) => /\.woff2$/.test(u)).length < 1) bad.push('no font file referenced by the stylesheet');
  return bad.length ? bad.slice(0, 3).join(', ') : null;
}

async function p53() {
  const rel = buildRelease();
  if (rel.status !== 0 || !rel.zip) return fail('no release zip to test');
  const base = makeTempDir('tt-accept-p5-');
  const dir = path.join(base, '发布 包 测试 folder'); // spaces and Chinese
  fs.mkdirSync(dir, { recursive: true });
  extractZip(rel.zip, dir);
  const problems = [];
  if (fs.existsSync(path.join(dir, 'node_modules'))) problems.push('node_modules exists in the fresh folder');
  if (fs.existsSync(path.join(dir, 'src'))) problems.push('src exists in the fresh folder');
  const dataDir = path.join(base, 'data dir');
  const port = await findFreeBase(2, 4700);

  // 1. node server/index.js directly, with nothing installed
  const srv = spawnProc(process.execPath, ['server/index.js', '--no-open', '--port', String(port), '--data-dir', dataDir], { cwd: dir, env: { ...process.env, TT_NO_OPEN: '1' } });
  try {
    await srv.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/, 30000);
    const health = await httpRaw(port, { path: '/api/health' });
    if (health.json?.app !== 'tuition-ticker') problems.push(`/api/health -> ${health.status} ${health.text.slice(0, 60)}`);
    const assets = await checkServedAssets(port);
    if (assets) problems.push(`served assets: ${assets}`);
    const data = await httpRaw(port, { path: '/api/data' });
    if (data.status !== 200) problems.push(`/api/data -> ${data.status}`);
  } catch (err) {
    problems.push(`node server/index.js in the fresh folder: ${err.message.slice(0, 160)}`);
  } finally {
    await srv.kill();
  }

  // 2. start.cmd (Windows): no npm needed, health ok
  let cmdNote = 'start.cmd run skipped (not Windows)';
  if (isWindows) {
    const port2 = port + 1;
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const run = spawnProc(comspec, ['/d', '/c', '.\\start.cmd'], { cwd: dir, env: { ...process.env, TT_NO_OPEN: '1', TT_PORT: String(port2), TT_DATA_DIR: dataDir } });
    try {
      await run.waitForLine(/TUITION_TICKER_URL=http:\/\/127\.0\.0\.1:(\d+)/, 60000);
      const health = await httpRaw(port2, { path: '/api/health' });
      if (health.json?.app !== 'tuition-ticker') problems.push(`start.cmd: /api/health -> ${health.status}`);
      const out = `${run.stdout}${run.stderr}`;
      if (/npm install|npm run build|added \d+ packages/i.test(out)) problems.push('start.cmd output mentions npm install / npm run build');
      if (out.includes('\u9996\u6b21\u8fd0\u884c')) problems.push('start.cmd showed the first-run (install + build) message');
      if (/\[ERROR\]/.test(out)) problems.push('start.cmd printed an [ERROR]');
      cmdNote = 'start.cmd (TT_NO_OPEN=1) started the server, /api/health ok, output has no npm install / npm run build';
    } catch (err) {
      problems.push(`start.cmd in the fresh folder: ${err.message.slice(0, 160)}`);
    } finally {
      killTree(run.child.pid);
    }
  }
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`zip unzipped into "…/发布 包 测试 folder" (spaces + Chinese; no node_modules, no src): node server/index.js --no-open --port --data-dir -> /api/health ok, GET / ok and every script / stylesheet / font it references answers 200; ${cmdNote}; no npm command was needed`);
}

// ------------------------------------------------------------------ P5.4 (workflow)
async function p54() {
  const wf = read('.github/workflows/release.yml');
  const problems = [];
  const lines = wf.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/\t/.test(l)) problems.push(`line ${i + 1}: tab character`);
    const indent = l.length - l.trimStart().length;
    if (l.trim() && !l.trim().startsWith('#') && indent % 2 !== 0) problems.push(`line ${i + 1}: odd indentation`);
    const opens = (l.match(/\[/g) ?? []).length - (l.match(/\]/g) ?? []).length;
    if (opens !== 0 && !l.trim().startsWith('#')) problems.push(`line ${i + 1}: unbalanced brackets`);
    const stripped = l.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    if (!l.trim().startsWith('#') && (stripped.includes('"') || (stripped.includes("'") && !/\w'\w/.test(stripped)))) problems.push(`line ${i + 1}: unbalanced quote`);
    if (l.trim() && !l.trim().startsWith('#') && !/^\s*(- )?[\w.-]+:( |$)|^\s*- |^\s+\S/.test(l)) problems.push(`line ${i + 1}: not a YAML key / item`);
  });
  for (const [re, what] of [
    [/^on:\s*\n\s+push:\s*\n\s+tags:\s*\['v\*'\]/m, "trigger push.tags: ['v*']"],
    [/^permissions:\s*\n\s+contents: write/m, 'permissions: contents: write'],
    [/actions\/checkout@v\d+/, 'checkout'],
    [/actions\/setup-node@v\d+[\s\S]*?node-version: 22/, 'setup-node with Node 22'],
    [/run: npm ci\b/, 'npm ci'],
    [/run: npm test\b/, 'npm test'],
    [/run: npm run release\b/, 'npm run release'],
    [/gh release create[^\n]*release\/\*\.zip|softprops\/action-gh-release/, 'create the Release and upload the zip'],
  ]) if (!re.test(wf)) problems.push(`workflow lacks: ${what}`);
  // order: checkout -> setup-node -> npm ci -> npm test -> release -> create
  const order = ['actions/checkout', 'actions/setup-node', 'npm ci', 'npm test', 'npm run release', 'gh release create'].map((s) => wf.indexOf(s));
  if (order.some((x) => x < 0) || order.some((x, i) => i > 0 && x < order[i - 1])) problems.push('workflow steps are not in the order checkout, setup-node, npm ci, npm test, npm run release, create release');
  // package-lock.json: present, tracked-able, consistent with package.json (what `npm ci` needs)
  if (!exists('package-lock.json')) problems.push('package-lock.json is missing');
  else {
    if (git('check-ignore', '-q', 'package-lock.json').status === 0) problems.push('package-lock.json is git-ignored');
    const lock = JSON.parse(read('package-lock.json'));
    const pkg = JSON.parse(read('package.json'));
    if (![2, 3].includes(lock.lockfileVersion)) problems.push(`lockfileVersion ${lock.lockfileVersion}`);
    if (lock.name !== pkg.name || lock.version !== pkg.version) problems.push('package-lock.json name / version differ from package.json');
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) if (!lock.packages?.[`node_modules/${dep}`]) problems.push(`${dep} is in package.json but not in package-lock.json`);
    if (git('ls-files', '--error-unmatch', 'package-lock.json').status !== 0 && git('check-ignore', '-q', 'package-lock.json').status === 0) problems.push('package-lock.json cannot be tracked');
  }
  let lint = 'actionlint not installed: skipped';
  const al = runCmd('actionlint', ['-version']);
  if (!al.error && al.status === 0) {
    const r = runCmd('actionlint', ['.github/workflows/release.yml']);
    if (r.status !== 0) problems.push(`actionlint: ${r.output.trim().slice(0, 160)}`);
    lint = 'actionlint passes';
  }
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`release.yml: trigger push.tags ['v*'], permissions contents: write, steps checkout -> setup-node 22 -> npm ci -> npm test -> npm run release -> gh release create (uploads release/*.zip); simple YAML structure check passes (no tabs, even indentation, balanced quotes / brackets); package-lock.json exists, is not ignored and matches package.json; ${lint}; the workflow was only written, never run`);
}

// ------------------------------------------------------------------ P5.5 (regression)
async function p55() {
  const problems = [];
  const t = npmTestOnce();
  if (t.status !== 0) problems.push(`npm test failed (exit ${t.status})`);
  const run = [];
  for (const cmd of ['check:arch', 'check:tokens', 'check:ui', 'check:i18n']) {
    const r = runShell(`npm run ${cmd}`);
    if (r.status !== 0) problems.push(`npm run ${cmd} failed: ${r.output.trim().slice(-120)}`);
    else run.push(cmd);
  }
  const b = runShell('npm run build', { timeoutMs: 300000 });
  if (b.status !== 0) problems.push(`npm run build failed: ${b.output.trim().slice(-150)}`);
  const st = git('status', '--porcelain', '-uall');
  if (st.status !== 0) problems.push('git status failed');
  const dirty = st.stdout.split('\n').map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((p) => /^(data|test-data\/private|\.pipeline|release|node_modules|coverage)\//.test(p));
  if (dirty.length) problems.push(`git status lists ignored-by-design paths: ${dirty.slice(0, 3).join(', ')}`);
  if (problems.length) return fail(problems.slice(0, 4).join('; '));
  return ok(`npm test, ${run.join(', ')} and npm run build pass; git status --porcelain lists nothing under data/, test-data/private/, .pipeline/, release/, node_modules/ or coverage/ (the P0-P4c rows of this table are the cumulative acceptance checks)`);
}

export const checks = [
  { id: 'P5.1', title: 'docs and scripts: start.command, LICENSE, READMEs (both languages), CONTRIBUTING, sample calendar, no private content', run: p51 },
  { id: 'P5.2', title: 'release zip: exact whitelist, nothing forbidden, start.command executable, release/ ignored', run: p52 },
  { id: 'P5.3', title: 'fresh folder: unzip (spaces + Chinese), no node_modules / src, server and start.cmd work, assets 200, no npm', run: p53 },
  { id: 'P5.4', title: 'GitHub Actions workflow (static check) and package-lock.json', run: p54 },
  { id: 'P5.5', title: 'regression: npm test, check:*, build, git status clean of ignored paths', run: p55 },
];
