#!/usr/bin/env node
// `npm run check:tokens` - verifies the design-token files.
//
//   contract  src/styles/tokens.css defines every required variable:
//               colours, shadows, fonts, type scale, weights, letter spacing, spacing, radii, motion
//                                  -> all in :root (the app has a light theme only)
//             and every :root variable of .pipeline/design/tokens-draft.css has the same value
//             (tokens.css may define more). The draft comparison is skipped when the draft is not present
//             (.pipeline/ is not committed).
//   fonts     public/fonts has a number-font and a body-font .woff2, every url() in src/styles/fonts.css
//             exists, each @font-face has font-display: swap, an OFL licence text is present, the folder
//             is smaller than 1.5 MB, and base.css has a rule with tabular-nums for .num.
//   contrast  WCAG contrast ratios of the key colour pairs.
//
// Output has one line per check group: "CHECK <group>: PASS|FAIL|SKIP ...", then details for failures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ CSS parsing (small, enough for token files)
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse top-level rules and @media blocks. Returns [{selector, media, decls: Map<name,value>}].
 * `media` is the normalised @media condition or null. Only custom properties and plain declarations are kept.
 */
export function parseRules(css) {
  const text = stripComments(css);
  const rules = [];
  let i = 0;

  function readBlock(media) {
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length || text[i] === '}') return;
      const headStart = i;
      while (i < text.length && text[i] !== '{' && text[i] !== ';') i++;
      const head = text.slice(headStart, i).trim();
      if (text[i] === ';') {
        i++; // at-rule without block (e.g. @import)
        continue;
      }
      i++; // skip {
      if (head.startsWith('@media')) {
        const cond = head.slice(6).replace(/\s+/g, ' ').trim();
        readBlock(cond);
        i++; // skip }
      } else if (head.startsWith('@')) {
        // @font-face and friends: parse as declarations under the at-rule name
        rules.push({ selector: head, media, decls: readDecls() });
        i++;
      } else {
        rules.push({ selector: head.replace(/\s+/g, ' '), media, decls: readDecls() });
        i++;
      }
    }
  }

  function readDecls() {
    const decls = new Map();
    let depth = 0;
    const start = i;
    while (i < text.length && !(text[i] === '}' && depth === 0)) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      i++;
    }
    for (const part of splitDeclarations(text.slice(start, i))) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '));
    }
    return decls;
  }

  readBlock(null);
  return rules;
}

function splitDeclarations(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

export const LOCATIONS = {
  root: { selector: ':root', media: null },
};

const norm = (s) => s.replace(/'/g, '"').replace(/\s+/g, '');

/** Collect variables per location from parsed rules (several rules for the same location are merged). */
export function collectVars(rules) {
  const out = { root: new Map() };
  for (const [key, loc] of Object.entries(LOCATIONS)) {
    for (const r of rules) {
      if (norm(r.selector) === norm(loc.selector) && (r.media ? norm(r.media) : null) === (loc.media ? norm(loc.media) : null)) {
        for (const [k, v] of r.decls) if (k.startsWith('--')) out[key].set(k, v);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the contract
export const COLOR_VARS = [
  '--color-bg', '--color-surface', '--color-surface-2', '--color-border', '--color-text', '--color-text-muted',
  '--color-number', '--color-accent', '--color-tank-fill', '--color-focus', '--color-slack-from', '--color-slack-to',
  '--color-slack-orb', '--color-on-slack', '--color-danger',
];
export const SHADOW_VARS = ['--shadow-sm', '--shadow-md', '--shadow-lg'];
export const THEME_VARS = [...COLOR_VARS, ...SHADOW_VARS];
export const ROOT_ONLY_VARS = [
  '--font-number', '--font-body', '--font-label',
  '--fs-display', '--fs-h1', '--fs-h2', '--fs-body', '--fs-small', '--fs-label',
  '--fw-regular', '--fw-bold', '--fw-heavy', '--ls-label',
  ...Array.from({ length: 8 }, (_, i) => `--space-${i + 1}`),
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-pill',
  '--dur-fast', '--dur-base', '--dur-slow', '--ease',
];

/** @returns {string[]} problems */
export function checkContract(tokensCss, draftCss) {
  const problems = [];
  const vars = collectVars(parseRules(tokensCss));
  for (const name of THEME_VARS) {
    if (!vars.root.has(name)) problems.push(`${name} missing in :root`);
  }
  for (const name of ROOT_ONLY_VARS) if (!vars.root.has(name)) problems.push(`${name} missing in :root`);

  if (draftCss !== null) {
    const draft = collectVars(parseRules(draftCss));
    for (const key of ['root']) {
      for (const [name, value] of draft[key]) {
        if (!vars[key].has(name)) problems.push(`draft variable ${name} not in tokens.css (${LOCATIONS[key].selector})`);
        else if (norm(vars[key].get(name)) !== norm(value)) problems.push(`${name} differs from the draft in ${LOCATIONS[key].selector}: tokens "${vars[key].get(name)}" vs draft "${value}"`);
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------ contrast (WCAG 2.x)
export function parseColor(value) {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

export function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const CONTRAST_PAIRS = [
  ['--color-text', '--color-bg', 4.5],
  ['--color-text', '--color-surface', 4.5],
  ['--color-text-muted', '--color-surface', 4.5],
  ['--color-number', '--color-bg', 4.5],
  ['--color-accent', '--color-bg', 3],
];

/** @returns {{problems: string[], rows: {theme: string, pair: string, ratio: number, min: number}[]}} */
export function checkContrast(tokensCss) {
  const vars = collectVars(parseRules(tokensCss));
  const problems = [];
  const rows = [];
  for (const [theme, key] of [['light', 'root']]) {
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      const a = vars[key].get(fg);
      const b = vars[key].get(bg);
      const ca = a ? parseColor(a) : null;
      const cb = b ? parseColor(b) : null;
      if (!ca || !cb) {
        problems.push(`${theme}: cannot read ${fg} / ${bg} as colours`);
        continue;
      }
      const ratio = contrastRatio(ca, cb);
      rows.push({ theme, pair: `${fg} on ${bg}`, ratio, min });
      if (ratio < min) problems.push(`${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    }
  }
  return { problems, rows };
}

// ------------------------------------------------------------------ fonts
export const FONT_LIMIT_BYTES = 1.5 * 1024 * 1024;

/** @returns {{problems: string[], files: {name: string, bytes: number}[], totalBytes: number}} */
export function checkFonts({ fontsCss, baseCss, publicDir }) {
  const problems = [];
  const fontsDir = path.join(publicDir, 'fonts');
  const entries = fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir) : [];
  const files = entries.map((name) => ({ name, bytes: fs.statSync(path.join(fontsDir, name)).size }));
  const woff2 = files.filter((f) => f.name.toLowerCase().endsWith('.woff2'));
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0);

  if (!woff2.some((f) => /manrope/i.test(f.name))) problems.push('no number-font (Manrope) .woff2 in public/fonts');
  if (!woff2.some((f) => /inter/i.test(f.name))) problems.push('no body-font (Inter) .woff2 in public/fonts');
  for (const f of woff2) {
    const head = fs.readFileSync(path.join(fontsDir, f.name)).subarray(0, 4).toString('latin1');
    if (head !== 'wOF2') problems.push(`${f.name} is not a woff2 file`);
  }
  const licences = files.filter((f) => /^(OFL|LICENSE)/i.test(f.name) && f.name.toLowerCase().endsWith('.txt'));
  const hasOfl = licences.some((f) => /SIL Open Font License/i.test(fs.readFileSync(path.join(fontsDir, f.name), 'utf8')));
  if (!hasOfl) problems.push('no OFL licence text (OFL*.txt containing "SIL Open Font License") in public/fonts');
  if (totalBytes >= FONT_LIMIT_BYTES) problems.push(`public/fonts is ${(totalBytes / 1024).toFixed(0)} KB, limit is ${FONT_LIMIT_BYTES / 1024} KB`);

  const rules = parseRules(fontsCss).filter((r) => r.selector === '@font-face');
  if (rules.length === 0) problems.push('fonts.css has no @font-face rule');
  const families = new Set();
  for (const r of rules) {
    const fam = (r.decls.get('font-family') ?? '').replace(/['"]/g, '');
    families.add(fam);
    if (r.decls.get('font-display') !== 'swap') problems.push(`@font-face ${fam}: font-display must be swap`);
    const src = r.decls.get('src') ?? '';
    const urls = [...src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
    if (urls.length === 0) problems.push(`@font-face ${fam}: no url()`);
    for (const url of urls) {
      const rel = url.replace(/^\//, '').split(/[?#]/)[0];
      if (!fs.existsSync(path.join(publicDir, rel))) problems.push(`fonts.css references ${url} but public/${rel} does not exist`);
    }
  }
  for (const fam of ['Manrope', 'Inter']) if (!families.has(fam)) problems.push(`fonts.css declares no @font-face for ${fam}`);

  const numRule = parseRules(baseCss).find((r) => r.selector.split(',').map((s) => s.trim()).includes('.num'));
  if (!numRule || !/tabular-nums/.test(numRule.decls.get('font-variant-numeric') ?? '')) problems.push('base.css: .num has no font-variant-numeric: tabular-nums');

  return { problems, files, totalBytes };
}

// ------------------------------------------------------------------ CLI
function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const draftPath = path.join(root, '.pipeline', 'design', 'tokens-draft.css');
  const draft = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf8') : null;
  let failed = false;
  const report = (group, problems, ok, skipNote) => {
    if (problems.length) {
      failed = true;
      console.log(`CHECK ${group}: FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
      for (const p of problems) console.log(`  - ${p}`);
    } else console.log(`CHECK ${group}: PASS ${ok}${skipNote ? ` (${skipNote})` : ''}`);
  };

  const tokens = read('src/styles/tokens.css');
  const contract = checkContract(tokens, draft);
  report('contract', contract, `${THEME_VARS.length} colour / shadow variables, ${ROOT_ONLY_VARS.length} root-only variables${draft ? ', identical to tokens-draft.css' : ''}`, draft ? '' : 'draft comparison skipped: .pipeline/design/tokens-draft.css not present');

  const fonts = checkFonts({ fontsCss: read('src/styles/fonts.css'), baseCss: read('src/styles/base.css'), publicDir: path.join(root, 'public') });
  report('fonts', fonts.problems, `${fonts.files.filter((f) => f.name.endsWith('.woff2')).length} woff2 files, ${(fonts.totalBytes / 1024).toFixed(0)} KB total: ${fonts.files.map((f) => f.name).join(', ')}`);

  const contrast = checkContrast(tokens);
  report('contrast', contrast.problems, `${contrast.rows.length} pairs, lowest ${Math.min(...contrast.rows.map((r) => r.ratio)).toFixed(2)}:1`);
  if (process.argv.includes('--verbose')) for (const r of contrast.rows) console.log(`  ${r.theme.padEnd(14)} ${r.pair.padEnd(44)} ${r.ratio.toFixed(2)}:1 (min ${r.min})`);

  console.log(failed ? 'check:tokens FAILED' : 'check:tokens OK');
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
