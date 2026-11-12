import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkArch, checkCoreSource, checkServerSource, findImports, lex } from '../../scripts/check-arch.mjs';
import { makeTempDir, projectRoot, removeDir } from '../server/helpers.js';

describe('check:arch lexer', () => {
  it('blanks comments and string contents but keeps line numbers', () => {
    const src = "const a = 'Date.now()'; // Date.now()\n/* window\n fetch */ const b = `x ${Date.now()} y`;\n";
    const { bare, code } = lex(src);
    assert.equal(bare.split('\n').length, src.split('\n').length);
    assert.ok(!/Date\.now\(\)[^}]*\/\//.test(bare));
    assert.equal((bare.match(/Date\.now/g) ?? []).length, 1, 'only the one inside ${} is code');
    assert.ok(!/window|fetch/.test(code));
  });
});

describe('check:arch server rule', () => {
  const root = path.resolve('/proj');
  const check = (src, file = 'server/x.js') => checkServerSource(src, file, root).violations;

  it('accepts node: built-ins and relative imports inside server/', () => {
    const src = [
      "import fs from 'node:fs';",
      "import { a } from './store.js';",
      "export * from '../server/router.js';",
      "const m = await import('node:path');",
      "import 'node:process';",
    ].join('\n');
    assert.deepEqual(check(src), []);
  });

  it('rejects third-party packages, bare built-ins, escaping paths and dynamic specifiers', () => {
    assert.equal(check("import express from 'express';").length, 1);
    assert.equal(check("import fs from 'fs';").length, 1);
    assert.equal(check("import { x } from '../src/core/billing.js';").length, 1);
    assert.equal(check("const x = require('left-pad');").length, 1);
    assert.equal(check("const m = await import(name);").length, 1);
    assert.equal(check("import('lodash').then(() => {});").length, 1);
    assert.equal(check("export { a } from 'chalk';").length, 1);
  });

  it('ignores import-like text inside comments', () => {
    assert.deepEqual(check("// import x from 'express'\n/* import y from 'lodash' */\nimport fs from 'node:fs';"), []);
  });
});

describe('check:arch core rule', () => {
  it('accepts pure code and mentions inside comments or strings', () => {
    const src = [
      '// never call Date.now() or new Date() here',
      "const doc = 'window.fetch(document)';",
      'export const f = (now: number) => new Date(now).getTime();',
      "import { x } from '../data/currencies';",
    ].join('\n');
    assert.deepEqual(checkCoreSource(src, 'src/core/a.ts'), []);
  });

  it('flags clock reads, DOM/network/storage access, and UI imports', () => {
    const cases = {
      'Date.now()': 'export const t = Date.now();',
      'new Date()': 'export const t = new Date();',
      'performance.now': 'export const t = performance.now();',
      document: 'export const t = document.title;',
      window: 'export const t = window.innerWidth;',
      fetch: 'export const t = fetch("/x");',
      localStorage: 'export const t = localStorage.getItem("a");',
      'ui import': "import { Dash } from '../ui/pages/Dash';",
      'state import': "import { s } from '../state/store';",
      'api import': "import { c } from '../api/client';",
      'inside template': 'export const t = `${Date.now()}`;',
    };
    for (const [name, src] of Object.entries(cases)) {
      assert.ok(checkCoreSource(src, 'src/core/a.ts').length >= 1, name);
    }
  });

  it('does not flag member names that merely look like globals, or new Date(arg)', () => {
    assert.deepEqual(checkCoreSource('const a = obj.window + obj.document; const d = new Date(ms);', 'src/core/a.ts'), []);
  });

  it('reports the right line number', () => {
    const v = checkCoreSource('const a = 1;\nconst b = 2;\nconst c = Date.now();\n', 'src/core/a.ts');
    assert.equal(v[0].line, 3);
  });
});

describe('check:arch on a directory tree', () => {
  it('reports violations per file and passes a clean tree', () => {
    const root = makeTempDir('tt-arch-');
    try {
      fs.mkdirSync(path.join(root, 'server'));
      fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
      fs.writeFileSync(path.join(root, 'server', 'ok.js'), "import fs from 'node:fs';\nexport default fs;\n");
      fs.writeFileSync(path.join(root, 'src', 'core', 'ok.ts'), 'export const f = (now: number) => now;\n');
      let r = checkArch(root);
      assert.deepEqual(r.violations, []);
      assert.equal(r.stats.serverFiles, 1);
      assert.equal(r.stats.coreFiles, 1);

      fs.writeFileSync(path.join(root, 'server', 'bad.js'), "import x from 'express';\n");
      fs.writeFileSync(path.join(root, 'src', 'core', 'bad.ts'), 'export const t = Date.now();\n');
      r = checkArch(root);
      assert.deepEqual(r.violations.map((v) => v.file).sort(), ['server/bad.js', 'src/core/bad.ts']);
    } finally {
      removeDir(root);
    }
  });

  it('the real repository passes', () => {
    const r = checkArch(projectRoot);
    assert.deepEqual(r.violations, []);
    assert.ok(r.stats.serverFiles >= 6);
  });
});

describe('findImports', () => {
  it('finds every import form', () => {
    const specs = findImports(
      [
        "import a from 'a';",
        "import { b } from 'b';",
        "import 'c';",
        "export * from 'd';",
        "const e = await import('e');",
        "const f = require('f');",
        "import type { G } from 'g';",
        'import {',
        '  h,',
        "} from 'h';",
      ].join('\n'),
    )
      .map((i) => i.spec)
      .sort();
    assert.deepEqual(specs, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
});
