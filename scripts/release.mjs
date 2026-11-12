#!/usr/bin/env node
// `npm run release` - build the interface and pack the release zip.
//
//   release/tuition-ticker-v<version>.zip     (version = package.json)
//
// The zip holds exactly this whitelist and nothing else, so an ordinary user can unzip it, install Node.js and
// double-click start.cmd / start.command without ever running npm:
//   start.cmd  start.command  server/  app/  package.json  README.md  README.en.md  LICENSE
// `start.command` carries the Unix mode 0755 (executable). Nothing is read from data/, test-data/, .pipeline/, src/ ...
//
//   node scripts/release.mjs [--skip-build]     --skip-build reuses an existing app/ (the acceptance script builds first)
//
// Nothing is published or pushed: the zip is only written to the (git-ignored) release/ folder.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const WHITELIST_FILES = ['start.cmd', 'start.command', 'package.json', 'README.md', 'README.en.md', 'LICENSE'];
export const WHITELIST_DIRS = ['server', 'app'];
/** Unix modes written into the zip (the zip host is Unix, so the mode survives unzip on macOS / Linux). */
export const MODE_FILE = 0o100644;
export const MODE_EXECUTABLE = 0o100755;
const EXECUTABLE = new Set(['start.command']);
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP_NAMES.has(entry.name) || entry.name.endsWith('.tmp') || entry.name.endsWith('.log')) continue;
    const abs = path.join(dir, entry.name);
    const name = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(abs, name, out);
    else if (entry.isFile()) out.push({ name, abs });
  }
}

/** The files that go into the zip: [{ name (forward slashes), abs }]. Throws when something on the whitelist is missing. */
export function collectEntries(rootDir = root) {
  const entries = [];
  for (const file of WHITELIST_FILES) {
    const abs = path.join(rootDir, file);
    if (!fs.existsSync(abs)) throw new Error(`release: ${file} is missing`);
    entries.push({ name: file, abs });
  }
  for (const dir of WHITELIST_DIRS) {
    const abs = path.join(rootDir, dir);
    if (!fs.existsSync(abs)) throw new Error(`release: ${dir}/ is missing${dir === 'app' ? ' (the build did not produce it)' : ''}`);
    walk(abs, dir, entries);
  }
  if (!entries.some((e) => e.name === 'app/index.html')) throw new Error('release: app/index.html is missing');
  return entries;
}

export function buildZip(entries) {
  const files = {};
  for (const { name, abs } of entries) {
    const data = new Uint8Array(fs.readFileSync(abs));
    const mode = EXECUTABLE.has(name) ? MODE_EXECUTABLE : MODE_FILE;
    // os 3 = Unix: the high 16 bits of the external attributes are the Unix mode.
    files[name] = [data, { level: 6, mtime: fs.statSync(abs).mtime, os: 3, attrs: (mode << 16) >>> 0 }];
  }
  return zipSync(files);
}

/**
 * The Windows portable edition: the same whitelist minus start.command, with portable/start.cmd as start.cmd and an
 * unmodified Node.js runtime under runtime/. Throws when the node.exe path does not exist.
 */
export function collectPortableEntries(nodeExe, rootDir = root) {
  if (!nodeExe || !fs.existsSync(nodeExe)) throw new Error(`release: node.exe not found: ${String(nodeExe)}`);
  const entries = collectEntries(rootDir).filter((e) => e.name !== 'start.cmd' && e.name !== 'start.command');
  entries.push({ name: 'start.cmd', abs: path.join(rootDir, 'portable', 'start.cmd') });
  entries.push({ name: 'runtime/node.exe', abs: nodeExe });
  entries.push({ name: 'runtime/NODE-NOTICE.txt', abs: path.join(rootDir, 'portable', 'NODE-NOTICE.txt') });
  return entries;
}

function main() {
  const skipBuild = process.argv.includes('--skip-build');
  const portableAt = process.argv.indexOf('--portable');
  const nodeExe = portableAt >= 0 ? process.argv[portableAt + 1] : null;
  if (portableAt >= 0 && (!nodeExe || nodeExe.startsWith('--'))) {
    console.error('release: --portable needs the path of a node.exe');
    process.exit(1);
  }
  if (!skipBuild) {
    console.log('release: building app/ (npm run build) ...');
    const build = spawnSync('npm run build', { cwd: root, shell: true, stdio: 'inherit' });
    if (build.status !== 0) {
      console.error('release: the build failed, nothing was written');
      process.exit(1);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
    console.error('release: package.json has no usable "version"');
    process.exit(1);
  }
  const entries = nodeExe ? collectPortableEntries(path.resolve(nodeExe)) : collectEntries();
  const zip = buildZip(entries);
  const outDir = path.join(root, 'release');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, nodeExe ? `tuition-ticker-v${pkg.version}-win-x64-portable.zip` : `tuition-ticker-v${pkg.version}.zip`);
  fs.writeFileSync(outFile, zip);
  console.log(`release: ${entries.length} files -> ${path.relative(root, outFile)} (${(zip.length / 1024).toFixed(0)} KB)`);
  console.log('RELEASE_ZIP=' + outFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
