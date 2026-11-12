import { describe, expect, it } from 'vitest';
import { pickCopy, placeholdersOf, renderTemplate } from '../../src/core/copy';
import type { CopyScene, Intensity } from '../../src/core/types';
import { COPY_ZH_CN } from '../../src/data/copy-zh-cn';
import { rng } from './helpers';

const INTENSITIES: Intensity[] = ['gentle', 'normal', 'extreme'];
const SCENES: CopyScene[] = ['in-class', 'slacking', 'break', 'settlement'];
const FULL = { course: 'MFIN7001', amount: 'HK$3.51', rate: 'HK$0.37', minutes: 12, count: 3, unit: '杯', item: '奶茶' };

describe('renderTemplate / placeholdersOf', () => {
  it('fills placeholders and reports missing values with null (never a leftover brace)', () => {
    expect(renderTemplate('你发呆的{minutes}分钟，够买{count}{unit}{item}', FULL)).toBe('你发呆的12分钟，够买3杯奶茶');
    expect(renderTemplate('{amount}', { amount: 'HK$1.00' })).toBe('HK$1.00');
    expect(renderTemplate('没有占位符', {})).toBe('没有占位符');
    expect(renderTemplate('{minutes}分钟{item}', { minutes: 5 })).toBeNull();
    expect(renderTemplate('{minutes}', { minutes: undefined })).toBeNull();
    expect(renderTemplate('{amount}', { amount: '' })).toBeNull();
    expect(renderTemplate('{minutes}', { minutes: 0 })).toBe('0');
    expect(placeholdersOf('a{x}b{y}{x}')).toEqual(['x', 'y', 'x']);
  });
});

describe('the zh-CN copy library', () => {
  it('has 3 intensities x 4 scenes x at least 10 templates', () => {
    for (const i of INTENSITIES) {
      expect(Object.keys(COPY_ZH_CN[i]).sort()).toEqual([...SCENES].sort());
      for (const s of SCENES) {
        const list = COPY_ZH_CN[i][s];
        expect(list.length, `${i}/${s}`).toBeGreaterThanOrEqual(10);
        expect(new Set(list).size, `${i}/${s} duplicates`).toBe(list.length);
      }
    }
  });

  it('renders every template without leaving "{" or "}" behind', () => {
    for (const i of INTENSITIES) {
      for (const s of SCENES) {
        for (const tpl of COPY_ZH_CN[i][s]) {
          const text = renderTemplate(tpl, FULL);
          expect(text, tpl).not.toBeNull();
          expect(text!).not.toMatch(/[{}]/);
          for (const name of placeholdersOf(tpl)) expect(Object.keys(FULL), `${tpl} uses unknown {${name}}`).toContain(name);
        }
      }
    }
  });

  it('has, for every scene, at least 3 templates that only need the always-available values', () => {
    const base: Record<CopyScene, string[]> = {
      'in-class': ['course', 'amount', 'minutes', 'rate'],
      slacking: ['minutes', 'amount'],
      break: ['minutes', 'course', 'amount'],
      settlement: ['minutes', 'amount'],
    };
    for (const i of INTENSITIES) {
      for (const s of SCENES) {
        const simple = COPY_ZH_CN[i][s].filter((t) => placeholdersOf(t).every((p) => base[s].includes(p)));
        expect(simple.length, `${i}/${s}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('pickCopy', () => {
  it('never repeats the previous line, over many consecutive picks', () => {
    for (const intensity of INTENSITIES) {
      for (const scene of SCENES) {
        const random = rng(intensity.length * 31 + scene.length);
        let previous: string | null = null;
        for (let i = 0; i < 300; i++) {
          const text = pickCopy({ intensity, scene, vars: FULL, previous, random });
          expect(text).not.toBeNull();
          expect(text).not.toBe(previous);
          expect(text!).not.toMatch(/[{}]/);
          previous = text;
        }
      }
    }
  });

  it('only picks templates whose placeholders have values', () => {
    const random = rng(5);
    for (let i = 0; i < 200; i++) {
      const text = pickCopy({ intensity: 'normal', scene: 'slacking', vars: { minutes: 7, amount: 'HK$2.00' }, random });
      expect(text).not.toBeNull();
      expect(text!).not.toMatch(/[{}]/);
      expect(text!).not.toMatch(/杯|盒/);
    }
  });

  it('returns null when no template can be rendered, and the only candidate even when it equals the previous one', () => {
    const needy = { ...COPY_ZH_CN, gentle: { ...COPY_ZH_CN.gentle, break: ['还有{minutes}分钟'] } };
    expect(pickCopy({ intensity: 'gentle', scene: 'break', vars: {}, library: needy })).toBeNull();
    const library = { ...COPY_ZH_CN, gentle: { ...COPY_ZH_CN.gentle, break: ['只有一条'] } };
    expect(pickCopy({ intensity: 'gentle', scene: 'break', vars: {}, previous: '只有一条', library })).toBe('只有一条');
  });

  it('uses the injected random source deterministically', () => {
    const lib = { ...COPY_ZH_CN, gentle: { ...COPY_ZH_CN.gentle, break: ['a', 'b', 'c'] } };
    expect(pickCopy({ intensity: 'gentle', scene: 'break', vars: {}, random: () => 0, library: lib })).toBe('a');
    expect(pickCopy({ intensity: 'gentle', scene: 'break', vars: {}, random: () => 0.99, library: lib })).toBe('c');
    expect(pickCopy({ intensity: 'gentle', scene: 'break', vars: {}, random: () => 0, previous: 'a', library: lib })).toBe('b');
    expect(typeof pickCopy({ intensity: 'extreme', scene: 'in-class', vars: FULL })).toBe('string'); // default Math.random
  });
});
