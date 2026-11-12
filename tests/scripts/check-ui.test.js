import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSource } from '../../scripts/check-ui.mjs';

const rules = (violations) => [...new Set(violations.map((v) => v.rule))].sort();

describe('check:ui colours', () => {
  it('flags hex colours and colour functions in ui and state code, including inside strings', () => {
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', "const c = '#FF8800';")), ['colours']);
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', 'const c = `rgb(1, 2, 3)`;')), ['colours']);
    assert.deepEqual(rules(checkSource('src/state/s.ts', "export const x = 'hsla(0, 0%, 0%, .5)';")), ['colours']);
  });

  it('flags colours in component stylesheets but not in tokens.css, and ignores comments', () => {
    assert.deepEqual(rules(checkSource('src/styles/components.css', '.a { color: #fff; }')), ['colours']);
    assert.deepEqual(rules(checkSource('src/styles/components.css', '.a { background: rgba(0, 0, 0, .3); }')), ['colours']);
    assert.deepEqual(rules(checkSource('src/styles/components.css', '.a { border: 1px solid white; }')), ['colours']);
    assert.deepEqual(checkSource('src/styles/tokens.css', ':root { --color-bg: #F4F5F7; }'), []);
    assert.deepEqual(checkSource('src/styles/components.css', '/* was #fff */ .a { color: var(--color-text); }'), []);
    assert.deepEqual(checkSource('src/ui/A.tsx', "// colour #fff is documented here\nconst h = '#/sessions';"), []);
  });

  it('does not mistake colour-mix or var() for hard-coded colours', () => {
    assert.deepEqual(checkSource('src/styles/components.css', '.a { box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-focus) 30%, transparent); }'), []);
  });
});

describe('check:ui text', () => {
  it('flags Chinese characters in code and JSX text under src/ui and src/state', () => {
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', "const label = '保存';")), ['text']);
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', 'export const A = () => <b>你好</b>;')), ['text']);
    assert.deepEqual(rules(checkSource('src/state/s.ts', 'export const m = `数据`;')), ['text']);
  });

  it('allows Chinese in comments, in src/i18n and in src/data', () => {
    assert.deepEqual(checkSource('src/ui/A.tsx', '// 这是注释\n/* 还有这个 */\nexport const a = 1;'), []);
    assert.deepEqual(checkSource('src/i18n/zh-CN.ts', "export const x = '保存';"), []);
    assert.deepEqual(checkSource('src/data/regions.ts', "export const x = '北半球';"), []);
  });
});

describe('check:ui money', () => {
  it('flags multiplication, division, modulo, toFixed and Math.round in src/ui', () => {
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', 'const total = rate * seconds;')), ['money']);
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', 'const avg = tuition / count;')), ['money']);
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', 'const r = (a + b) % 7;')), ['money']);
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', 'const s = amount.toFixed(2);')), ['money']);
    assert.deepEqual(rules(checkSource('src/ui/A.tsx', 'const s = Math.round(amount);')), ['money']);
  });

  it('accepts JSX tags, strings and comments, and allows the maths in src/state', () => {
    const jsx = "export const A = () => (<div class=\"a\"><span>{x}</span><br /><input value={'a/b'} /></div>);\n// total = a * b\n";
    assert.deepEqual(checkSource('src/ui/A.tsx', jsx), []);
    assert.deepEqual(checkSource('src/state/s.ts', 'export const avg = (t: number, n: number) => t / n;'), []);
    assert.deepEqual(checkSource('src/ui/A.tsx', "import x from '../state/x';\nexport const y = x;"), []);
  });
});
