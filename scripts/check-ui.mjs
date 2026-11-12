#!/usr/bin/env node
// `npm run check:ui` - keeps the UI layer honest (rules from CLAUDE.md and the P3a plan).
//
//   colours   no hard-coded colours (#rgb / #rrggbb, rgb(), rgba(), hsl(), named colours in CSS declarations) in
//             src/ui/, src/state/ and in the component stylesheets under src/styles/ (only tokens.css may define
//             colours; fonts.css and base.css are checked as well).
//   text      no Chinese characters in code under src/ui/ and src/state/: every visible string goes through t()
//             and lives in src/i18n/. (Comments may be Chinese or English.)
//   money     src/ui/ does no money maths: no binary * / %, no toFixed(), no Math.round / floor / ceil / trunc.
//             Amounts are computed by core (or formatted in src/state) and only displayed.
//
// Comments are ignored by every rule. Known limitation: the tiny lexer (shared with check:arch) does not
// understand regular-expression literals.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from './check-arch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAMED_COLORS = 'white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|cyan|magenta|brown|gold';
const HEX = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b/;
const COLOR_FN = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/i;
const CSS_NAMED = new RegExp(`(?:color|background(?:-color)?|border(?:-[a-z]+)*|fill|stroke|outline(?:-[a-z]+)*)\\s*:[^;{}]*\\b(?:${NAMED_COLORS})\\b`, 'i');
const CJK = /[⺀-⿟　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
const MONEY_OP = /[\w)\]]\s*[*/%]\s*[\w(]/;
const MONEY_FN = /\.toFixed\s*\(|\bMath\.(?:round|floor|ceil|trunc)\s*\(/;

const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scan(text, regex, message, file, out) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  for (const m of text.matchAll(re)) out.push({ file, line: lineOf(text, m.index ?? 0), message: `${message}: ${m[0].trim()}` });
}

/**
 * Check one file. `relPath` uses forward slashes relative to the project root.
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
export function checkSource(relPath, source) {
  const out = [];
  const isCss = relPath.endsWith('.css');
  const inUi = relPath.startsWith('src/ui/');
  const inState = relPath.startsWith('src/state/');
  const add = (rule, found) => out.push(...found.map((f) => ({ ...f, rule })));

  if (isCss) {
    const css = stripCssComments(source);
    if (relPath !== 'src/styles/tokens.css') {
      const found = [];
      scan(css, HEX, 'hard-coded colour', relPath, found);
      scan(css, COLOR_FN, 'hard-coded colour', relPath, found);
      scan(css, CSS_NAMED, 'named colour', relPath, found);
      add('colours', found);
    }
    if (inUi) {
      const found = [];
      scan(css, CJK, 'Chinese text', relPath, found);
      add('text', found);
    }
    return out;
  }

  const { code, bare } = lex(source);
  if (inUi || inState) {
    const colours = [];
    scan(code, HEX, 'hard-coded colour', relPath, colours);
    scan(code, COLOR_FN, 'hard-coded colour', relPath, colours);
    add('colours', colours);
    const text = [];
    scan(code, CJK, 'Chinese text (use t() and src/i18n)', relPath, text);
    add('text', text);
  }
  if (inUi) {
    const money = [];
    // JSX closing / self-closing tags contain slashes that are not division.
    const noJsx = bare.replace(/<\//g, '< ').replace(/\/>/g, ' >');
    scan(noJsx, MONEY_OP, 'arithmetic in the UI layer', relPath, money);
    scan(noJsx, MONEY_FN, 'number formatting / rounding in the UI layer', relPath, money);
    add('money', money);
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function listFiles() {
  const files = [...walk(path.join(root, 'src', 'ui')), ...walk(path.join(root, 'src', 'state')), ...walk(path.join(root, 'src', 'styles'))];
  return files.filter((f) => /\.(?:tsx?|css)$/.test(f)).map((f) => path.relative(root, f).split(path.sep).join('/'));
}

function main() {
  const files = listFiles();
  const violations = [];
  for (const rel of files) violations.push(...checkSource(rel, fs.readFileSync(path.join(root, rel), 'utf8')));
  let failed = false;
  for (const rule of ['colours', 'text', 'money']) {
    const mine = violations.filter((v) => v.rule === rule);
    if (mine.length) {
      failed = true;
      console.log(`CHECK ${rule}: FAIL (${mine.length} violation${mine.length === 1 ? '' : 's'})`);
      for (const v of mine) console.log(`  - ${v.file}:${v.line} ${v.message}`);
    } else {
      console.log(`CHECK ${rule}: PASS`);
    }
  }
  console.log(`scanned ${files.length} files (src/ui, src/state, src/styles)`);
  console.log(failed ? 'check:ui FAILED' : 'check:ui OK');
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
