// P3a acceptance checks (front-end foundations and onboarding). Standard numbers match .pipeline/PLAN.md: P3a.1 ... P3a.6.
// P3a.6 (visual) is not automated; P3a.4 automates its data half (see the dev report for the browser half).

import fs from 'node:fs';
import path from 'node:path';
import { root, npmTestOnce, requireVitest, runShell, ok, fail } from './lib.mjs';

const fixture = path.join(root, 'tests', 'fixtures', 'full-term.ics');

// ------------------------------------------------------------------ P3a.1
async function p3a1() {
  const v = requireVitest(/^tests\/state\/(sync|i18n-api)\.test\.ts$/, [
    'calls GET /api/data exactly once and fills the state',
    'five changes within 500 ms produce exactly one PUT',
    'on 409 refetches everything and shows the notice',
    'sends the X-Tuition-Ticker header on every write',
  ]);
  if (!v.ok) return v;
  const notice = fs.readFileSync(path.join(root, 'src', 'i18n', 'zh-CN.ts'), 'utf8').includes('数据在别的标签页被改过，已刷新');
  if (!notice) return fail('the conflict notice text is not in src/i18n/zh-CN.ts');

  const test = npmTestOnce();
  if (test.status !== 0) return fail(`npm test exited ${test.status}`);
  const passed = test.output.split('\n').filter((l) => /^\s*[✔✓]/.test(l));
  const required = [
    'stores the uploaded text under calendars/<id>.ics and returns the id',
    'refuses ids with path characters and answers 404 for an unknown safe id',
    'rejects text that is not an iCalendar file with 400 and writes nothing',
    'is idempotent: the same text gives the same id and no second file',
  ];
  const missing = required.filter((n) => !passed.some((l) => l.includes(n)));
  if (missing.length) return fail(`node:test case(s) not seen passing: ${missing.join('; ')}`);
  return ok(`${v.detail}; POST/DELETE /api/calendars cases pass (file appears in calendars/, disappears on DELETE, ../x refused)`);
}

// ------------------------------------------------------------------ P3a.2
async function p3a2() {
  const v = requireVitest(/^tests\/state\/clock\.test\.ts$/, [
    'updates on animation frames while the page is visible',
    'updates at most once per second while hidden',
    'updates immediately when the page becomes visible again',
    '?now=...&freeze=1 pins the clock',
    '?now=... without freeze starts there and then advances one second per second',
    'ignores both parameters when development mode is off',
  ]);
  if (!v.ok) return v;

  // Production bundle: the test hooks must be compiled out.
  const build = runShell('npm run build');
  if (build.status !== 0) return fail(`npm run build exited ${build.status}`);
  const assets = path.join(root, 'app', 'assets');
  const js = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
  if (js.length === 0) return fail('no .js in app/assets after the build');
  const leaks = [];
  for (const f of js) {
    const text = fs.readFileSync(path.join(assets, f), 'utf8');
    if (text.includes('__tt_debug')) leaks.push(`${f} contains __tt_debug`);
    if (/["'`]freeze["'`]/.test(text)) leaks.push(`${f} reads the freeze parameter`);
  }
  if (leaks.length) return fail(`dev-only hooks are present in the production bundle: ${leaks.join('; ')}`);
  return ok(`${v.detail}; production bundle contains neither __tt_debug nor the ?now / freeze handling (${js.length} js file(s) checked)`);
}

// ------------------------------------------------------------------ P3a.3
async function p3a3() {
  const logic = requireVitest(/^tests\/state\/onboarding\.test\.ts$/, [
    'turns typed major-unit amounts into integer minor units without floating-point error',
    'blocks step 3 and the final step while the tuition is empty or 0',
    'fills 09-01 / 12-31 for the northern hemisphere and 01-01 / 07-01 for the southern one',
    'per-semester and per-year billing give different, correct structures',
    'imports a plain .ics',
    'imports a .zip',
    'what is ticked on the recognition page changes the step-7 preview',
  ]);
  if (!logic.ok) return logic;
  const ui = requireVitest(/^tests\/ui\/onboarding\.test\.tsx$/, [
    'walks through all seven steps and writes the config on finish',
    '"finish" is disabled when the tuition is empty',
  ]);
  if (!ui.ok) return ui;
  return ok(`${logic.detail}; component tests: ${ui.detail}`);
}

// ------------------------------------------------------------------ P3a.4 (data half)
async function p3a4() {
  const args = ['--file', fixture, '--tuition', '398000', '--currency', 'HKD', '--period', 'semester', '--json'];
  const inspect = runShell(`npx tsx scripts/inspect-calendar.ts ${args.map((a) => `"${a}"`).join(' ')}`);
  if (inspect.status !== 0) return fail(`inspect exited ${inspect.status}: ${inspect.output.trim().slice(-200)}`);
  const ref = JSON.parse(inspect.stdout);

  const wiz = runShell(`npx tsx scripts/acceptance/p3a-preview.ts "${fixture}" 398000 HKD semester`);
  if (wiz.status !== 0) return fail(`preview script exited ${wiz.status}: ${wiz.output.trim().slice(-200)}`);
  const got = JSON.parse(wiz.stdout.trim().split('\n').at(-1));

  const problems = [];
  if (got.sessionCount !== ref.billableSessions) problems.push(`sessions ${got.sessionCount} vs inspect ${ref.billableSessions}`);
  if (got.pools.length !== ref.pools.length) problems.push(`pool count ${got.pools.length} vs inspect ${ref.pools.length}`);
  ref.pools.forEach((p, i) => {
    const w = got.pools[i];
    if (!w) return;
    if (w.sessions !== p.sessions) problems.push(`pool ${i + 1} sessions ${w.sessions} vs ${p.sessions}`);
    if (Number(w.hours) !== p.totalHours) problems.push(`pool ${i + 1} hours ${w.hours} vs ${p.totalHours}`);
    const rate = `HK$${p.ratePerSecondMajor.toFixed(4)}`;
    if (w.rate !== rate) problems.push(`pool ${i + 1} cost per second ${w.rate} vs ${rate}`);
    const avg = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p.averageSessionCostMinor / 100);
    if (w.average !== `HK$${avg}`) problems.push(`pool ${i + 1} average per session ${w.average} vs HK$${avg}`);
  });
  const totalHours = ref.pools.reduce((s, p) => s + p.totalHours, 0);
  if (Math.abs(Number(got.hours) - totalHours) > 0.05) problems.push(`total hours ${got.hours} vs ${totalHours}`);
  if (problems.length) return fail(problems.join('; '));
  return ok(`wizard preview = inspect output for full-term.ics: ${got.sessionCount} sessions, ${got.hours} h, ${got.rate} per second, ${got.average} per session over ${got.pools.length} pools (browser half: see dev report)`);
}

// ------------------------------------------------------------------ P3a.5
async function p3a5() {
  const ui = runShell('npm run check:ui');
  if (ui.status !== 0) return fail(`check:ui exited ${ui.status}: ${ui.output.trim().split('\n').slice(-6).join(' | ')}`);
  const scanned = (ui.output.match(/scanned (\d+) files/) ?? [])[1];
  if (!scanned || Number(scanned) < 10) return fail(`check:ui scanned only ${scanned ?? 0} files`);
  const arch = runShell('npm run check:arch');
  if (arch.status !== 0) return fail(`check:arch exited ${arch.status}`);
  const tokens = runShell('npm run check:tokens');
  if (tokens.status !== 0) return fail(`check:tokens exited ${tokens.status}`);
  const test = npmTestOnce();
  if (test.status !== 0) return fail(`npm test exited ${test.status}`);
  const rules = ['colours', 'text', 'money'].filter((r) => !new RegExp(`CHECK ${r}: PASS`).test(ui.output));
  if (rules.length) return fail(`check:ui rule(s) not reported as PASS: ${rules.join(', ')}`);
  return ok(`check:ui OK (${scanned} files: no hard-coded colours, no Chinese literals in ui/state, no money maths in ui); check:arch, check:tokens and npm test pass`);
}

export const checks = [
  { id: 'P3a.1', title: 'data sync (GET once, debounced PUT, 409 refresh, /api/calendars)', run: p3a1 },
  { id: 'P3a.2', title: 'now clock (frames, hidden throttle, ?now / freeze in dev only)', run: p3a2 },
  { id: 'P3a.3', title: 'onboarding logic and components', run: p3a3 },
  { id: 'P3a.4', title: 'wizard preview agrees with inspect (data half)', run: p3a4 },
  { id: 'P3a.5', title: 'code constraints (check:ui, check:arch, tests)', run: p3a5 },
];
