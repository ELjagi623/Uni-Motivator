#!/usr/bin/env node
// `npm run acceptance` - cumulative acceptance script. Automates every criterion marked [auto] in
// .pipeline/PLAN.md, phase by phase (later phases append their checks to the list below, never replace).
//
//   npm run acceptance                 run everything
//   npm run acceptance -- --only P0.4  run selected check ids (comma separated) or a whole phase (e.g. P0)
//
// Prints a PASS/FAIL table and exits non-zero when any check fails.

import { checks as p0 } from './acceptance/p0.mjs';
import { checks as p1 } from './acceptance/p1.mjs';
import { cleanupAll } from './acceptance/lib.mjs';

const all = [...p0, ...p1];

function parseOnly(argv) {
  const i = argv.indexOf('--only');
  if (i === -1) return null;
  return String(argv[i + 1] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const only = parseOnly(process.argv.slice(2));
const selected = only
  ? all.filter((c) => only.some((o) => c.id.toLowerCase() === o || c.id.toLowerCase().startsWith(`${o}.`)))
  : all;

if (selected.length === 0) {
  console.error(`no checks match ${only?.join(',')}`);
  process.exit(2);
}

const rows = [];
for (const check of selected) {
  const started = Date.now();
  process.stdout.write(`running ${check.id} ${check.title} ...\n`);
  let result;
  try {
    result = await check.run();
  } catch (err) {
    result = { ok: false, detail: `exception: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}` };
  }
  rows.push({ id: check.id, title: check.title, ok: result.ok, detail: result.detail, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  process.stdout.write(`  -> ${result.ok ? 'PASS' : 'FAIL'} (${rows.at(-1).seconds}s)\n`);
}
cleanupAll();

const failed = rows.filter((r) => !r.ok);
console.log('\n| ID | Result | Criterion | Detail |');
console.log('|---|---|---|---|');
for (const r of rows) console.log(`| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.title} | ${String(r.detail).replace(/\|/g, '/')} |`);
console.log(`\nacceptance: ${rows.length - failed.length} PASS, ${failed.length} FAIL`);
process.exit(failed.length ? 1 : 0);
