// @vitest-environment happy-dom
// B4 small fixes: (1) cancelling the "unit price will change" question keeps what was typed in the add-class form;
// (2) the Chinese copy lines put a space between a number and the Chinese text next to it (like the dictionaries do);
// (3) English quantities read naturally ("304 boxes of three-dish rice", "1 box of ...", no "×").

import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COPY_LIBRARIES } from '../../src/core/copy';
import { PRICE_PACK_HK, PRICE_PACK_TEXT, localizeItem } from '../../src/data/price-pack-hk';
import { setLocale, t } from '../../src/i18n';
import { manualSessions } from '../../src/state/derived';
import { equivalentHint, equivalentOf } from '../../src/state/slack';
import { skipTextOf } from '../../src/state/sessions';
import { boot, flushSaves, teardown } from './harness';
import { NOWS } from '../state/fixture-app';

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});
afterEach(() => {
  teardown();
  setLocale('zh-CN');
  localStorage.clear();
});

describe('add-class form after cancelling the price question', () => {
  const fill = async (h: Awaited<ReturnType<typeof boot>>) => {
    await h.click('#manual-open');
    await h.type('#manual-name', 'Seminar');
    await act(async () => h.$<HTMLInputElement>('input[name="manual-weekday"][value="2"]')!.click());
    await h.type('#manual-start', '14:00');
    await h.type('#manual-end', '17:00');
    await h.type('#manual-from', '2026-09-08');
    await h.type('#manual-to', '2026-12-01');
    await h.type('#manual-skip', '2026-10-06');
  };

  it('weekly form: cancel keeps every typed value; confirming adds the class and then empties the form', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await fill(h);
    await h.click('#manual-submit-weekly');
    expect(h.$('#manual-dialog')).not.toBeNull();
    await h.click('#manual-dialog-cancel');
    expect(h.$('#manual-dialog')).toBeNull();
    expect(manualSessions.value).toHaveLength(0);
    const value = (sel: string) => h.$<HTMLInputElement>(sel)!.value;
    expect([value('#manual-name'), value('#manual-start'), value('#manual-end'), value('#manual-from'), value('#manual-to'), value('#manual-skip')]).toEqual(['Seminar', '14:00', '17:00', '2026-09-08', '2026-12-01', '2026-10-06']);
    expect(h.$<HTMLInputElement>('input[name="manual-weekday"][value="2"]')!.checked).toBe(true);

    // asking again and confirming adds it, and only then is the form emptied
    await h.click('#manual-submit-weekly');
    await h.click('#manual-dialog-ok');
    await flushSaves();
    await h.settle();
    expect(manualSessions.value).toHaveLength(12);
    expect(value('#manual-name')).toBe('');
    expect(value('#manual-from')).toBe('');
  });

  it('one-off form: cancel keeps the date and times', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await h.click('#manual-open');
    await act(async () => h.$<HTMLInputElement>('input[name="manual-tab"][value="single"]')!.click());
    await h.type('#manual-date', '2026-11-14');
    await h.type('#manual-start', '10:00');
    await h.type('#manual-end', '12:30');
    await h.click('#manual-submit-single');
    expect(h.$('#manual-dialog')).not.toBeNull();
    await h.click('#manual-dialog-cancel');
    expect(manualSessions.value).toHaveLength(0);
    const value = (sel: string) => h.$<HTMLInputElement>(sel)!.value;
    expect([value('#manual-date'), value('#manual-start'), value('#manual-end')]).toEqual(['2026-11-14', '10:00', '12:30']);
  });
});

describe('Chinese copy lines: a space between a number and the Chinese text', () => {
  const CJK_NEXT_TO_NUMBER = /[㐀-鿿]\{(minutes|count)\}|\{(minutes|count)\}[㐀-鿿]/;
  for (const locale of ['zh-CN', 'zh-TW'] as const) {
    it(`${locale}: no {minutes} / {count} touches a Chinese character, and the count is followed by a space before the counter word`, () => {
      const lines = Object.values(COPY_LIBRARIES[locale]).flatMap((scenes) => Object.values(scenes).flat());
      expect(lines.length).toBeGreaterThan(100);
      for (const line of lines) {
        expect(line, line).not.toMatch(CJK_NEXT_TO_NUMBER);
        if (line.includes('{count}')) expect(line, line).toMatch(/\{count\} \{unit\}\{item\}/);
      }
    });
  }

  it('the 繁體 minutes line reads "走神 0 分鐘" with spaces, like the dictionary strings', () => {
    const line = COPY_LIBRARIES['zh-TW'].gentle.settlement.find((l) => l.includes('走神'))!;
    expect(line).toContain('走神 {minutes} 分鐘');
  });
});

describe('English quantities', () => {
  it('every item has a singular and a plural English form; the unit is empty (no "×")', () => {
    for (const item of PRICE_PACK_HK) {
      const en = PRICE_PACK_TEXT[item.id].en;
      expect(en.unit, item.id).toBe('');
      expect(en.plural, item.id).toBeTruthy();
      expect(en.plural, item.id).not.toBe(en.name);
      expect(localizeItem(item, 'en', 1).name).toBe(en.name);
      expect(localizeItem(item, 'en', 304).name).toBe(en.plural);
      expect(localizeItem(item, 'en', 0).name).toBe(en.plural);
    }
    // the other languages do not care about the quantity
    const sanfan = PRICE_PACK_HK.find((i) => i.id === 'sanfan')!;
    expect(localizeItem(sanfan, 'zh-TW', 5)).toEqual({ name: '三餸飯', unit: '盒' });
    expect(localizeItem(sanfan, 'zh-CN', 5)).toEqual({ name: '三餸饭', unit: '盒' });
  });

  it('the English copy lines name items as "{count} {item}" and never use "×"', () => {
    const lines = Object.values(COPY_LIBRARIES.en).flatMap((scenes) => Object.values(scenes).flat());
    expect(lines.filter((l) => l.includes('{count}')).length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line, line).not.toContain('×');
      if (line.includes('{count}')) expect(line, line).toContain('{count} {item}');
    }
  });

  it('t() collapses the gap an empty parameter leaves', () => {
    setLocale('en');
    expect(t('slack.equivalentNow', { count: 3, unit: '', name: 'boxes of three-dish rice' })).toBe('Already wasted 3 boxes of three-dish rice');
  });

  it('skip calculator, slacking hint, settlement card and copy variables read naturally in English', async () => {
    setLocale('en');
    // 304 boxes (the same figure the P4c test uses): plural
    expect(skipTextOf(1_372_414, 'HKD')).toBe('Skipping this class = throwing away HK$13,724.14 ≈ 304 boxes of three-dish rice');
    // exactly one box: singular; less than one box: "1 box"
    expect(skipTextOf(4_500, 'HKD')).toBe('Skipping this class = throwing away HK$45.00 ≈ 1 box of three-dish rice');
    expect(skipTextOf(3_000, 'HKD')).toBe('Skipping this class = throwing away HK$30.00, not even enough for 1 box of three-dish rice');
    // slacking page: the equivalent is the dearest item the money buys (HK$190 = 2 movie tickets at HK$95)
    expect(equivalentHint(19_000, 'HKD')).toContain('Already wasted 2 movie tickets');
    expect(equivalentHint(9_500, 'HKD')).toContain('Already wasted 1 movie ticket');
    expect(equivalentHint(400, 'HKD')).toContain('A little more and you could buy 1 one-way bus fare');
    for (const cents of [400, 9_500, 19_000, 26_500]) expect(equivalentHint(cents, 'HKD'), String(cents)).not.toMatch(/ {2}|×/);
    // the settlement card shows a fraction (HK$265 = 1.1 hotpot seats): plural; the quantity 1 stays singular
    const e = equivalentOf(26_500, 'HKD')!;
    expect(e.name).toBe('hotpot buffet seat');
    expect(e.many.name).toBe('hotpot buffet seats');
    expect(e.one.name).toBe('hotpot buffet seat');
    expect(e.many.unit).toBe('');
    // zh-TW keeps its counter word and the space after the number
    setLocale('zh-TW');
    expect(equivalentHint(19_000, 'HKD')).toContain('已經浪費 2 張電影票');
  });
});
