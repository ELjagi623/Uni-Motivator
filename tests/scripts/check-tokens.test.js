import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkContract, checkContrast, checkFonts, collectVars, contrastRatio, parseColor, parseRules, ROOT_ONLY_VARS, THEME_VARS } from '../../scripts/check-tokens.mjs';
import { makeTempDir, projectRoot, removeDir } from '../server/helpers.js';

const read = (p) => fs.readFileSync(path.join(projectRoot, p), 'utf8');
const tokens = read('src/styles/tokens.css');

describe('check:tokens helpers', () => {
  it('computes WCAG contrast ratios', () => {
    assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2), '21.00');
    assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]).toFixed(2), '1.00');
    assert.equal(contrastRatio([119, 119, 119], [255, 255, 255]).toFixed(2), '4.48'); // #777 on white
  });

  it('parses hex and rgb colours', () => {
    assert.deepEqual(parseColor('#0F2547'), [15, 37, 71]);
    assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseColor('rgba(255, 190, 140, 0.22)'), [255, 190, 140]);
    assert.equal(parseColor('red'), null);
  });

  it('parses :root, theme blocks and @media blocks', () => {
    const rules = parseRules('/* c */ :root{--a:1;--b: rgba(1, 2, 3, .5)} @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--a:2}} [data-theme="dark"]{--a:3}');
    const vars = collectVars(rules);
    assert.equal(vars.root.get('--a'), '1');
    assert.equal(vars.root.get('--b'), 'rgba(1, 2, 3, .5)');
    assert.equal(vars.system.get('--a'), '2');
    assert.equal(vars.dark.get('--a'), '3');
  });
});

describe('check:tokens contract', () => {
  it('the real tokens.css satisfies the contract and is identical to the draft when the draft exists', () => {
    const draftPath = path.join(projectRoot, '.pipeline', 'design', 'tokens-draft.css');
    const draft = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf8') : null;
    assert.deepEqual(checkContract(tokens, draft), []);
    assert.deepEqual(checkContrast(tokens).problems, []);
  });

  it('reports a theme variable missing in one of the places', () => {
    const broken = tokens.replace(/(@media[^{]*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{[\s\S]*?)--color-danger:[^;]*;/, '$1');
    const problems = checkContract(broken, null);
    assert.ok(problems.some((p) => p.includes('--color-danger') && p.includes('prefers-color-scheme')), problems.join('\n'));
  });

  it('reports a root-only variable that is missing, and dark / system blocks that disagree', () => {
    assert.ok(checkContract(tokens.replace('--space-8: 64px;', ''), null).some((p) => p.includes('--space-8')));
    const disagree = tokens.replace(/(\[data-theme="dark"\]\s*\{[\s\S]*?--color-bg:\s*)#0F1626/, '$1#000000');
    assert.ok(checkContract(disagree, null).some((p) => p.includes('--color-bg') && p.includes('differ')));
  });

  it('reports a value that differs from the draft and a draft variable that is absent', () => {
    const draft = tokens.replace('--color-accent: #96651B;', '--color-accent: #111111;');
    assert.ok(checkContract(tokens, draft).some((p) => p.includes('--color-accent') && p.includes('differs from the draft')));
    assert.ok(checkContract(tokens, `${tokens}\n:root{--only-in-draft: 1px;}`).some((p) => p.includes('--only-in-draft')));
  });

  it('the contract lists every variable of the PLAN', () => {
    for (const v of ['--color-bg', '--color-slack-orb', '--shadow-lg', '--color-on-slack', '--color-danger']) assert.ok(THEME_VARS.includes(v), v);
    for (const v of ['--font-number', '--fs-display', '--ls-label', '--space-1', '--space-8', '--radius-pill', '--dur-slow', '--ease']) assert.ok(ROOT_ONLY_VARS.includes(v), v);
  });

  it('fails the contrast check for a low-contrast palette', () => {
    const weak = tokens.replace(/(:root\s*\{[\s\S]*?--color-text:\s*)#1B2436/, '$1#CCCCCC');
    assert.ok(checkContrast(weak).problems.some((p) => p.includes('--color-text on --color-bg')));
  });
});

describe('check:tokens fonts', () => {
  const fontsCss = read('src/styles/fonts.css');
  const baseCss = read('src/styles/base.css');
  const publicDir = path.join(projectRoot, 'public');

  it('passes for the real files', () => {
    const r = checkFonts({ fontsCss, baseCss, publicDir });
    assert.deepEqual(r.problems, []);
    assert.ok(r.totalBytes < 1.5 * 1024 * 1024);
  });

  it('flags a url() that points nowhere, a missing licence, a missing font-display and a .num without tabular-nums', () => {
    const tmp = makeTempDir('tt-fonts-');
    try {
      fs.mkdirSync(path.join(tmp, 'fonts'));
      fs.writeFileSync(path.join(tmp, 'fonts', 'manrope-x.woff2'), 'wOF2....');
      const css = "@font-face{font-family:'Manrope';src:url('/fonts/missing.woff2') format('woff2');}";
      const r = checkFonts({ fontsCss: css, baseCss: '.num{color:red}', publicDir: tmp });
      const text = r.problems.join('\n');
      assert.match(text, /missing\.woff2/);
      assert.match(text, /OFL licence/);
      assert.match(text, /font-display/);
      assert.match(text, /tabular-nums/);
      assert.match(text, /Inter/);
    } finally {
      removeDir(tmp);
    }
  });
});
