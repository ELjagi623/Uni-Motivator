// P2 acceptance checks (design tokens and fonts). Standard numbers match .pipeline/PLAN.md: P2.1 ... P2.4.
// P2.5 (preview page, visual) is not automated; see the dev report.

import fs from 'node:fs';
import path from 'node:path';
import { root, memo, runShell, ok, fail } from './lib.mjs';

const designDir = path.join(root, '.pipeline', 'design');

// ------------------------------------------------------------------ P2.1
async function p21() {
  const indexPath = path.join(designDir, 'INDEX.md');
  if (!fs.existsSync(indexPath)) {
    // .pipeline/ is not committed: a fresh clone has no design folder, which is not a failure.
    return ok('skipped: .pipeline/design/INDEX.md not present (.pipeline/ is not part of the repository)');
  }
  const text = fs.readFileSync(indexPath, 'utf8');
  const problems = [];

  if (!text.includes('确认状态：未经用户确认')) problems.push('INDEX.md lacks "确认状态：未经用户确认"');
  if (!/https:\/\/claude\.ai\/\S+/.test(text) && !/\.pipeline\/design\/\S+/.test(text)) problems.push('INDEX.md has neither a design link nor a local source path');
  for (const font of ['Manrope', 'Inter']) if (!text.includes(font)) problems.push(`selected font ${font} not named`);

  // The screen table: 7 rows, each with 日间 and 夜间 marked as designed.
  const rows = text.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
  const numbers = rows.map((l) => Number(l.match(/^\|\s*(\d+)/)[1]));
  if (rows.length !== 7 || numbers.join() !== '1,2,3,4,5,6,7') problems.push(`screen table has ${rows.length} rows (${numbers.join(',')}), expected screens 1..7`);
  for (const l of rows) {
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    if (cells[2] !== '已设计' || cells[3] !== '已设计') problems.push(`screen ${cells[0]}: day / night not both marked 已设计`);
  }

  // Every referenced local file exists (paths are relative to .pipeline/design or repo-root style .pipeline/design/...).
  const refs = new Set();
  for (const m of text.matchAll(/`([^`\s]+\.(?:html|css|json|md))`/g)) refs.add(m[1]);
  let checked = 0;
  for (const ref of refs) {
    // INDEX.md names files relative to .pipeline/design, relative to canvas/project (nested bullets), or by repo path / bare name.
    const rel = ref.replace(/^\.pipeline\/design\//, '');
    const candidates = [path.join(designDir, rel), path.join(designDir, 'canvas', 'project', rel), path.join(root, ref), path.join(root, 'src', 'styles', ref)];
    if (!candidates.some((c) => fs.existsSync(c))) problems.push(`referenced file missing: ${ref}`);
    else checked++;
  }
  if (checked < 8) problems.push(`only ${checked} referenced design files were found (expected the 7 screens plus tokens-draft.css)`);
  if (!fs.existsSync(path.join(designDir, 'tokens-draft.css'))) problems.push('tokens-draft.css missing');

  return problems.length ? fail(problems.join('; ')) : ok(`INDEX.md: confirmation status line, font names, 7 screens x day/night all 已设计, ${checked} referenced files exist, 确认状态 = 未经用户确认`);
}

// ------------------------------------------------------------------ P2.2 - P2.4 (one check:tokens run)
const tokensRun = () => memo('check:tokens', () => runShell('npm run check:tokens'));

function groupResult(group) {
  const r = tokensRun();
  const line = r.stdout.split('\n').find((l) => l.startsWith(`CHECK ${group}:`));
  if (!line) return fail(`check:tokens printed no "${group}" line (exit ${r.status})`);
  if (!line.startsWith(`CHECK ${group}: PASS`)) {
    const details = r.stdout.split('\n').filter((l) => l.startsWith('  - ')).slice(0, 4).join(' ');
    return fail(`${line}${details ? ` ${details}` : ''}`);
  }
  return ok(line.replace(`CHECK ${group}: PASS `, ''));
}

async function p22() {
  const r = groupResult('contract');
  if (!r.ok) return r;
  const draftNote = fs.existsSync(path.join(designDir, 'tokens-draft.css')) ? '' : ' (draft comparison skipped: tokens-draft.css not present)';
  return ok(`${r.detail}${draftNote}`);
}

async function p23() {
  const r = groupResult('fonts');
  if (!r.ok) return r;
  const dir = path.join(root, 'public', 'fonts');
  const files = fs.readdirSync(dir);
  return ok(`public/fonts: ${files.join(', ')}; ${r.detail.split(' total')[0].split(', ').slice(-1)[0] ?? ''} total; fonts.css urls exist, font-display swap, OFL text present, .num has tabular-nums`);
}

async function p24() {
  return groupResult('contrast');
}

export const checks = [
  { id: 'P2.1', title: 'design deliverables in place (skipped when .pipeline/ is absent)', run: p21 },
  { id: 'P2.2', title: 'token contract complete and identical to the draft', run: p22 },
  { id: 'P2.3', title: 'font files, @font-face references, OFL, size, tabular-nums', run: p23 },
  { id: 'P2.4', title: 'WCAG contrast of key colour pairs (light theme)', run: p24 },
];
