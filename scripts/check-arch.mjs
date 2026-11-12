#!/usr/bin/env node
// `npm run check:arch` - enforces the architecture rules from CLAUDE.md.
//
//   server/    only `node:` built-ins and relative imports (zero third-party dependencies), and relative
//              imports must stay inside server/.
//   src/core/  pure functions: no Date.now(), no argument-less `new Date()`, no performance.now(), no
//              DOM/network/storage globals (document, window, fetch, localStorage, ...), and no imports of
//              ui/, state/, api/ (or preact).
//
// Comments and string contents are ignored by the core rules, so documentation may mention these names.
// Known limitation: regular-expression literals are not understood by the tiny lexer below.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EXT = /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/;

/**
 * Single pass over JS/TS source.
 * @returns {{code: string, bare: string}}
 *   code = comments blanked (strings kept); bare = comments blanked and string/template text blanked.
 *   Newlines are preserved in both so line numbers stay valid.
 */
export function lex(src) {
  const code = [];
  const bare = [];
  const templateStack = []; // brace depth at which each open `${` started
  let depth = 0;
  let mode = 'normal'; // normal | line | block | sq | dq | tpl
  const push = (c, keepInBare) => {
    code.push(c);
    bare.push(keepInBare ? c : c === '\n' ? '\n' : ' ');
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'normal';
        push(c, true);
      } else push(' ', false);
    } else if (mode === 'block') {
      if (c === '*' && n === '/') {
        push(' ', false);
        push(' ', false);
        i++;
        mode = 'normal';
      } else push(c === '\n' ? '\n' : ' ', false);
    } else if (mode === 'sq' || mode === 'dq') {
      const quote = mode === 'sq' ? "'" : '"';
      if (c === '\\') {
        push(c, false);
        if (n !== undefined) {
          push(n, false);
          i++;
        }
      } else if (c === quote || c === '\n') {
        push(c, true);
        mode = 'normal';
      } else push(c, false);
    } else if (mode === 'tpl') {
      if (c === '\\') {
        push(c, false);
        if (n !== undefined) {
          push(n, false);
          i++;
        }
      } else if (c === '`') {
        push(c, true);
        mode = 'normal';
      } else if (c === '$' && n === '{') {
        push('$', false);
        push('{', true);
        i++;
        templateStack.push(depth);
        depth++;
        mode = 'normal';
      } else push(c, false);
    } else {
      // normal
      if (c === '/' && n === '/') {
        push(' ', false);
        push(' ', false);
        i++;
        mode = 'line';
      } else if (c === '/' && n === '*') {
        push(' ', false);
        push(' ', false);
        i++;
        mode = 'block';
      } else if (c === "'") {
        push(c, true);
        mode = 'sq';
      } else if (c === '"') {
        push(c, true);
        mode = 'dq';
      } else if (c === '`') {
        push(c, true);
        mode = 'tpl';
      } else if (c === '{') {
        depth++;
        push(c, true);
      } else if (c === '}') {
        if (templateStack.length && depth === templateStack[templateStack.length - 1] + 1) {
          depth = templateStack.pop();
          push(c, true);
          mode = 'tpl';
        } else {
          depth--;
          push(c, true);
        }
      } else push(c, true);
    }
  }
  return { code: code.join(''), bare: bare.join('') };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** @returns {{spec: string | null, line: number}[]}  spec === null means a dynamic, non-literal import. */
export function findImports(src) {
  const { code } = lex(src);
  const found = [];
  const add = (re, specGroup) => {
    for (const m of code.matchAll(re)) {
      found.push({ spec: specGroup === null ? null : m[specGroup], line: lineOf(code, m.index) });
    }
  };
  add(/\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g, 2);
  add(/\bimport\s*(['"])([^'"]+)\1/g, 2);
  add(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, 2);
  add(/\bimport\s*\(\s*(?!['"`])/g, null);
  add(/\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, 2);
  return found;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, out);
    } else if (CODE_EXT.test(e.name)) out.push(full);
  }
  return out;
}

const CORE_PATTERNS = [
  { re: /(?<![.\w$])Date\s*\.\s*now\b/g, msg: 'Date.now() is not allowed in core; take `now` as a parameter' },
  { re: /\bnew\s+Date\s*\(\s*\)/g, msg: 'argument-less new Date() is not allowed in core; take `now` as a parameter' },
  { re: /(?<![.\w$])performance\s*\.\s*now\b/g, msg: 'performance.now() is not allowed in core' },
  {
    re: /(?<![.\w$])(document|window|fetch|localStorage|sessionStorage|XMLHttpRequest|WebSocket|navigator)\b/g,
    msg: (m) => `\`${m[1]}\` (DOM / network / storage) is not allowed in core`,
  },
];

/** Check one file's source for the `server/` rule. `file` is relative to root, for messages and path checks. */
export function checkServerSource(src, file, root) {
  const violations = [];
  let imports = 0;
  const fileDir = path.dirname(path.join(root, file));
  const serverRoot = path.join(root, 'server');
  for (const { spec, line } of findImports(src)) {
    imports++;
    if (spec === null) {
      violations.push({ file, line, msg: 'dynamic import() with a non-literal specifier cannot be verified' });
    } else if (spec.startsWith('node:')) {
      // built-in module: fine
    } else if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
      const target = path.resolve(fileDir, spec);
      const rel = path.relative(serverRoot, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        violations.push({ file, line, msg: `relative import "${spec}" leaves server/` });
      }
    } else {
      violations.push({
        file,
        line,
        msg: `"${spec}" is not allowed in server/ (only node: built-ins and relative paths; bare built-ins need the node: prefix)`,
      });
    }
  }
  return { violations, imports };
}

/** Check one file's source for the `src/core/` rules. */
export function checkCoreSource(src, file) {
  const violations = [];
  const { bare } = lex(src);
  for (const { re, msg } of CORE_PATTERNS) {
    for (const m of bare.matchAll(re)) {
      violations.push({ file, line: lineOf(bare, m.index), msg: typeof msg === 'function' ? msg(m) : msg });
    }
  }
  for (const { spec, line } of findImports(src)) {
    if (spec === null) continue;
    if (/(^|\/)(ui|state|api)(\/|$)/.test(spec)) {
      violations.push({ file, line, msg: `core must not import from ui/, state/ or api/ ("${spec}")` });
    } else if (/^(@?preact)(\/|$)/.test(spec)) {
      violations.push({ file, line, msg: `core must not import UI libraries ("${spec}")` });
    }
  }
  return violations;
}

export function checkArch(root) {
  const violations = [];
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');

  const serverFiles = walk(path.join(root, 'server'));
  let serverImports = 0;
  for (const f of serverFiles) {
    const r = checkServerSource(fs.readFileSync(f, 'utf8'), rel(f), root);
    serverImports += r.imports;
    violations.push(...r.violations);
  }

  const coreFiles = walk(path.join(root, 'src', 'core'));
  for (const f of coreFiles) violations.push(...checkCoreSource(fs.readFileSync(f, 'utf8'), rel(f)));

  return { violations, stats: { serverFiles: serverFiles.length, serverImports, coreFiles: coreFiles.length } };
}

function main() {
  const rootArg = process.argv.indexOf('--root');
  const root = path.resolve(
    rootArg !== -1 ? process.argv[rootArg + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const { violations, stats } = checkArch(root);
  const serverBad = violations.filter((v) => v.file.startsWith('server/')).length;
  const coreBad = violations.filter((v) => v.file.startsWith('src/core/')).length;
  console.log(`server/   : ${stats.serverFiles} files, ${stats.serverImports} imports checked, ${serverBad} violations (zero third-party imports: ${serverBad === 0 ? 'yes' : 'NO'})`);
  console.log(`src/core/ : ${stats.coreFiles} files checked, ${coreBad} violations`);
  for (const v of violations) console.log(`  ${v.file}:${v.line}: ${v.msg}`);
  if (violations.length > 0) {
    console.log(`check:arch FAILED (${violations.length} violations)`);
    process.exitCode = 1;
  } else {
    console.log('check:arch OK');
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
