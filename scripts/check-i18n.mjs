#!/usr/bin/env node
// `npm run check:i18n` - the three interface languages must stay in step.
//
//   keys          zh-CN, zh-TW and en have exactly the same set of message keys (no missing, no extra, no duplicate).
//   placeholders  every key has the same {placeholders} in all three languages.
//   empty         no message is empty.
//   copy          the copy libraries (src/data/copy-*.ts) have lines for every intensity x scene, and every line only uses
//                 the placeholders its scene provides.
//   ui            (the "no Chinese literals in src/ui and src/state" rule lives in check:ui and keeps applying.)
//
// The dictionaries are read as text (one `'key': 'value',` entry per line), so the script needs no TypeScript runtime.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DICTIONARIES = [
  { locale: 'zh-CN', file: 'src/i18n/zh-CN.ts' },
  { locale: 'zh-TW', file: 'src/i18n/zh-TW.ts' },
  { locale: 'en', file: 'src/i18n/en.ts' },
];
export const COPY_FILES = [
  { locale: 'zh-CN', file: 'src/data/copy-zh-cn.ts' },
  { locale: 'zh-TW', file: 'src/data/copy-zh-tw.ts' },
  { locale: 'en', file: 'src/data/copy-en.ts' },
];
const SCENE_PLACEHOLDERS = {
  'in-class': ['course', 'amount', 'rate', 'minutes'],
  slacking: ['minutes', 'amount', 'count', 'unit', 'item', 'course'],
  break: ['minutes', 'course', 'amount'],
  settlement: ['minutes', 'amount', 'count', 'unit', 'item', 'course'],
};
const INTENSITIES = ['gentle', 'normal', 'extreme'];
const MIN_LINES = 8;

const SQ = "'((?:[^'\\\\]|\\\\.)*)'";
const DQ = '"((?:[^"\\\\]|\\\\.)*)"';
const ENTRY = new RegExp(`^\\s*'([^']+)'\\s*:\\s*(?:${SQ}|${DQ})\\s*,?\\s*$`);
const ITEM = new RegExp(`^      (?:${SQ}|${DQ}),?\\s*$`);
const unescape = (text) => text.replace(/\\(.)/g, '$1');
const placeholdersOf = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Parse the `'key': 'value'` lines of a dictionary file. */
export function parseDictionary(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ENTRY.exec(line);
    if (m) entries.push({ key: m[1], value: unescape(m[2] ?? m[3] ?? '') });
  }
  return entries;
}

/** Parse a copy library: { intensity: { scene: [lines] } }. */
export function parseCopyLibrary(text) {
  const lib = {};
  let intensity = null;
  let scene = null;
  for (const line of text.split(/\r?\n/)) {
    const level = /^ {2}(gentle|normal|extreme): \{/.exec(line);
    if (level) {
      intensity = level[1];
      lib[intensity] = {};
      scene = null;
      continue;
    }
    const sc = /^ {4}'?([a-z-]+)'?: \[/.exec(line);
    if (sc && intensity) {
      scene = sc[1];
      lib[intensity][scene] = [];
      continue;
    }
    const item = ITEM.exec(line);
    if (item && intensity && scene) lib[intensity][scene].push(unescape(item[1] ?? item[2] ?? ''));
  }
  return lib;
}

/**
 * @param {Record<string, string>} dictTexts locale -> file text
 * @param {Record<string, string>} copyTexts locale -> file text
 * @returns {string[]} problems (empty = all good)
 */
export function checkI18n(dictTexts, copyTexts) {
  const problems = [];
  const parsed = {};
  for (const { locale } of DICTIONARIES) {
    const entries = parseDictionary(dictTexts[locale] ?? '');
    const map = new Map();
    for (const e of entries) {
      if (map.has(e.key)) problems.push(`${locale}: duplicate key ${e.key}`);
      map.set(e.key, e.value);
      if (e.value.trim() === '') problems.push(`${locale}: empty message ${e.key}`);
    }
    parsed[locale] = map;
  }
  const base = parsed['zh-CN'];
  if (base.size === 0) problems.push('zh-CN: no keys found');
  for (const { locale } of DICTIONARIES) {
    if (locale === 'zh-CN') continue;
    const map = parsed[locale];
    for (const key of base.keys()) if (!map.has(key)) problems.push(`${locale}: missing key ${key}`);
    for (const key of map.keys()) if (!base.has(key)) problems.push(`${locale}: extra key ${key}`);
    for (const [key, value] of map) {
      const want = base.get(key);
      if (want === undefined) continue;
      if (placeholdersOf(want).join(',') !== placeholdersOf(value).join(',')) {
        problems.push(`${locale}: placeholders of ${key} differ from zh-CN ({${placeholdersOf(want).join('} {')}} vs {${placeholdersOf(value).join('} {')}})`);
      }
    }
  }
  for (const { locale } of COPY_FILES) {
    const lib = parseCopyLibrary(copyTexts[locale] ?? '');
    for (const level of INTENSITIES) {
      for (const [scene, allowed] of Object.entries(SCENE_PLACEHOLDERS)) {
        const lines = lib[level]?.[scene] ?? [];
        if (lines.length < MIN_LINES) problems.push(`copy ${locale}: ${level} / ${scene} has ${lines.length} lines, at least ${MIN_LINES} needed`);
        for (const line of lines) {
          const bad = placeholdersOf(line).filter((p) => !allowed.includes(p));
          if (bad.length) problems.push(`copy ${locale}: ${level} / ${scene} uses {${bad.join('} {')}} which that scene does not provide`);
        }
      }
    }
  }
  return problems;
}

function main() {
  const dictTexts = Object.fromEntries(DICTIONARIES.map(({ locale, file }) => [locale, fs.readFileSync(path.join(root, file), 'utf8')]));
  const copyTexts = Object.fromEntries(COPY_FILES.map(({ locale, file }) => [locale, fs.readFileSync(path.join(root, file), 'utf8')]));
  const problems = checkI18n(dictTexts, copyTexts);
  const counts = DICTIONARIES.map(({ locale }) => `${locale}: ${parseDictionary(dictTexts[locale]).length} keys`).join(', ');
  console.log(`CHECK keys / placeholders / copy: ${problems.length === 0 ? 'PASS' : 'FAIL'} (${counts})`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
  if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
  console.log(problems.length === 0 ? 'check:i18n OK' : `check:i18n FAILED (${problems.length} problems)`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
