// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billingStateAt, buildPools } from '../../src/core/billing';
import { convert, formatMinor, pairRate } from '../../src/core/money';
import { CURRENCIES, RATES_UPDATED } from '../../src/data/currencies';
import { rateText } from '../../src/state/dashboard';
import { pools as statePools } from '../../src/state/derived';
import { config } from '../../src/state/data';
import { installPrivacyShortcut, privacyOn, setPrivacy } from '../../src/state/privacy';
import { nowOverride } from '../../src/state/now';
import { boot, flushSaves, teardown, type Harness } from './harness';
import { CLASS_ID, NOWS, fixtureConfig, fullTermText, hk, inputsFor } from '../state/fixture-app';

const root = path.resolve(__dirname, '..', '..');
const slackDocs = {
  slacks: { records: [{ id: 'r1', sessionId: 'ft-mon-s1@fixture|2026-11-09T01:00:00Z', startMs: hk('2026-11-09T10:00:00'), endMs: hk('2026-11-09T10:20:00') }] },
  marks: { marks: { 'ft-mon-s1@fixture|2026-11-02T01:00:00Z': { status: 'skipped' } } },
};

let stops: Array<() => void> = [];

beforeEach(() => {
  vi.unstubAllGlobals();
  stops = [];
  localStorage.clear();
});

afterEach(() => {
  for (const stop of stops) stop();
  setPrivacy(false);
  stops = [];
  teardown();
  localStorage.clear();
  vi.restoreAllMocks();
});

function press(key: string): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// ------------------------------------------------------------------ privacy mode

const symbolRe = CURRENCIES.map((c) => c.symbol.replace(/[$]/g, '\\$')).join('|');
const MONEY = new RegExp(`(?:${symbolRe})\\s?-?\\d|\\d{1,3}(?:,\\d{3})*\\.\\d{2}(?!\\d)`);

/** Visible text (and input values) that looks like money but is not inside a `.money` element. */
function unblurredMoney(host: HTMLElement): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const el = node.parentElement;
    if (!el || !MONEY.test(text)) continue;
    if (el.closest('.money, .sr-only, title, script, style')) continue;
    found.push(`<${el.tagName.toLowerCase()} class="${el.className}"> ${text.trim().slice(0, 50)}`);
  }
  for (const input of Array.from(host.querySelectorAll('input'))) {
    if (MONEY.test(input.value) && !input.closest('.money')) found.push(`<input#${input.id}> ${input.value}`);
  }
  return found;
}

describe('privacy mode on the pages', () => {
  const cases: Array<[string, Parameters<typeof boot>[0]]> = [
    ['dashboard: in class', { path: '/', nowMs: NOWS.inClass }],
    ['dashboard: break', { path: '/', nowMs: NOWS.break }],
    ['dashboard: done for today', { path: '/', nowMs: NOWS.doneToday }],
    ['dashboard: no class today', { path: '/', nowMs: NOWS.noClassToday }],
    ['dashboard: before the term', { path: '/', nowMs: NOWS.beforeTerm }],
    ['dashboard: after the term', { path: '/', nowMs: NOWS.afterTerm }],
    ['session list', { path: '/sessions', nowMs: NOWS.doneToday, docs: slackDocs }],
    ['statistics', { path: '/stats', nowMs: NOWS.doneToday, docs: slackDocs }],
    ['settings', { path: '/settings', nowMs: NOWS.doneToday }],
  ];

  for (const [name, options] of cases) {
    it(`B blurs every amount on the ${name} (and a second B restores them)`, async () => {
      const h = await boot(options);
      stops.push(installPrivacyShortcut(document));
      if (options?.path === '/sessions') await h.click(`tr[data-session-id="${CLASS_ID}"] .row-btn`);
      expect(h.$$('.money').length, 'the page has no .money elements').toBeGreaterThan(0);
      expect(unblurredMoney(h.host), 'amounts outside .money').toEqual([]);
      expect(document.documentElement.hasAttribute('data-privacy')).toBe(false);
      await act(async () => press('b'));
      expect(document.documentElement.getAttribute('data-privacy')).toBe('on');
      expect(h.$('#privacy-toggle')?.getAttribute('aria-pressed')).toBe('true');
      await act(async () => press('B'));
      expect(document.documentElement.hasAttribute('data-privacy')).toBe(false);
    });
  }

  it('the stats and settings amounts of a multi-semester timetable are all marked too (every tuition field, every table cell)', async () => {
    const h = await boot({ path: '/stats', nowMs: NOWS.afterTerm, docs: slackDocs });
    expect(unblurredMoney(h.host)).toEqual([]);
    expect(h.$$('#courses-table td.money').length).toBeGreaterThan(0);
  });

  it('the tab title shows no amount while the mode is on', async () => {
    const h = await boot({ path: '/', nowMs: NOWS.inClass });
    stops.push(installPrivacyShortcut(document));
    const { computeTitle } = await import('../../src/state/title');
    expect(computeTitle()).toMatch(/HK\$/);
    await act(async () => press('b'));
    expect(computeTitle()).toBe('学费计价器');
    expect(h.host).toBeTruthy();
  });

  it('a tuition field being edited is not blurred while it has the focus (the rule lifts the blur)', () => {
    const css = fs.readFileSync(path.join(root, 'src', 'styles', 'components.css'), 'utf8');
    expect(css).toMatch(/\[data-privacy='on'\]\s*\.money:focus-within[^}]*filter:\s*none/);
    expect(privacyOn.value).toBe(false);
  });
});

// ------------------------------------------------------------------ second currency

describe('second currency', () => {
  const chooseSecond = async (h: Harness, code: string) => {
    const input = h.$<HTMLInputElement>(`input[name="settings-second"][value="${code}"]`);
    expect(input, code).not.toBeNull();
    await act(async () => input!.click());
    await h.settle();
  };

  it('is off by default: no small line under the big number', async () => {
    const h = await boot({ path: '/', nowMs: NOWS.inClass });
    expect(h.$('.secondary-amount')).toBeNull();
  });

  it('shows "≈ amount" under the main number = core convert(main, main currency, second) formatted, and the main number is unchanged', async () => {
    const plain = await boot({ path: '/', nowMs: NOWS.inClass });
    const mainBefore = plain.field('session-consumed');
    const cfg = { ...fixtureConfig(), secondaryCurrency: 'CNY' as const };
    const h = await boot({ path: '/', nowMs: NOWS.inClass, configOverride: cfg });
    expect(h.field('session-consumed')).toBe(mainBefore);
    const main = Number((h.field('session-consumed') ?? '').replace(/,/g, '')) * 100;
    const expected = `≈ ${formatMinor(Math.round(convert(main, 'HKD', 'CNY')), 'CNY')}`;
    expect(h.field('session-consumed-second')).toBe(expected);
    expect(expected).toMatch(/^≈ ¥[\d,]+\.\d{2}$/);
    // a smaller, secondary line: it is marked as money (blurred in privacy mode) and is not the big number
    expect(h.$('[data-field="session-consumed-second"]')?.className).toContain('money');
    expect(h.$('[data-field="session-consumed-second"]')?.className).not.toContain('hero-number');
  });

  it('the settings choose the second currency (never the main one) and show the rate table date', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday });
    expect(h.$('#rates-updated')?.textContent).toContain(RATES_UPDATED);
    const options = h.$$('input[name="settings-second"]').map((i) => (i as HTMLInputElement).value);
    expect(options).toEqual(['off', 'CNY', 'USD', 'GBP', 'EUR', 'CAD', 'AUD']);
    expect(h.$('#exchange-rate')).toBeNull();
    await chooseSecond(h, 'USD');
    expect((config.value as { secondaryCurrency?: string }).secondaryCurrency).toBe('USD');
    expect(h.$<HTMLInputElement>('#exchange-rate')?.value).toBe(String(Number(pairRate('HKD', 'USD').toPrecision(6))));
    await chooseSecond(h, 'off');
    expect(h.$('#exchange-rate')).toBeNull();
  });

  it('a rate of 0 or below is refused (error shown, nothing saved); a good rate is saved and the display updates at once', async () => {
    const cfg = { ...fixtureConfig(), secondaryCurrency: 'CNY' as const };
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass, configOverride: cfg });
    const putsBefore = h.server.puts('config').length;
    for (const bad of ['0', '-3', 'abc', '']) {
      await h.type('#exchange-rate', bad);
      expect(h.$('#exchange-rate-note')?.textContent, bad).toBe('汇率必须是大于 0 的数字。');
      expect(h.$('#exchange-rate')?.getAttribute('aria-invalid')).toBe('true');
    }
    await flushSaves();
    expect(h.server.puts('config').length).toBe(putsBefore);
    expect((config.value as { rates?: unknown }).rates).toBeUndefined();

    await h.type('#exchange-rate', '0.9');
    expect(h.$('#exchange-rate-note')?.textContent).toBe('人民币');
    expect(pairRate('HKD', 'CNY', config.value.rates)).toBeCloseTo(0.9, 10);
    expect(h.$('#rates-custom')).not.toBeNull();
    // the dashboard (same app) converts with the new rate straight away
    await act(async () => {
      location.hash = '#/';
    });
    await h.settle();
    const main = Number((h.field('session-consumed') ?? '').replace(/,/g, '')) * 100;
    expect(h.field('session-consumed-second')).toBe(`≈ ${formatMinor(Math.round(main * 0.9), 'CNY')}`);
  });

  it('"restore built-in rates" removes the manual rates', async () => {
    const cfg = { ...fixtureConfig(), secondaryCurrency: 'CNY' as const, rates: { CNY: 0.2 } };
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass, configOverride: cfg });
    expect(h.$<HTMLInputElement>('#exchange-rate')?.value).toBe(String(Number((0.128 / 0.2).toPrecision(6))));
    await h.click('#rates-reset');
    expect((config.value as { rates?: unknown }).rates).toBeUndefined();
    expect(h.$<HTMLInputElement>('#exchange-rate')?.value).toBe(String(Number(pairRate('HKD', 'CNY').toPrecision(6))));
    expect(h.$('#rates-custom')).toBeNull();
  });

  it('the second currency also appears under the term figures of the non-class screens', async () => {
    const cfg = { ...fixtureConfig(), secondaryCurrency: 'USD' as const };
    for (const [now, field] of [
      [NOWS.beforeTerm, 'pool-tuition-second'],
      [NOWS.afterTerm, 'pool-tuition-second'],
      [NOWS.doneToday, 'today-spent-second'],
    ] as const) {
      const h = await boot({ path: '/', nowMs: now, configOverride: cfg });
      expect(h.field(field), String(now)).toMatch(/^≈ US\$[\d,]+\.\d{2}$/);
    }
  });
});

// ------------------------------------------------------------------ billing mode and credits

describe('billing mode and credits', () => {
  const ratesOf = (mode: 'duration' | 'credit', credits: Record<string, number | null>) => {
    const cfg = fixtureConfig();
    const courses = (cfg.courses ?? []).map((c) => ({ ...c, credits: credits[c.code ?? ''] ?? null }));
    const inputs = inputsFor({ ...cfg, courses }, [fullTermText]);
    const built = buildPools(inputs.sessions, { academic: cfg.academic!, mode, tuition: cfg.tuition!, credits: Object.fromEntries(courses.map((c) => [c.id, c.credits])) });
    return { courses, built, pool: built[0] };
  };

  it('the settings have a mode switch and a credits field per course (positive numbers only)', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday });
    expect(h.$$('input[name="settings-mode"]').map((i) => i.parentElement?.textContent)).toEqual(['时长均摊', '学分加权']);
    const credits = h.$$('#credit-fields input');
    expect(credits).toHaveLength(2);
    for (const bad of ['0', '-1', 'abc', '1e3']) {
      await h.type('#credit-fields input', bad);
      expect(h.$('#credit-fields [role="alert"]')?.textContent, bad).toBe('学分必须是大于 0 的数字（也可以留空）。');
      expect(h.$<HTMLButtonElement>('#settings-save')?.disabled).toBe(true);
    }
    await h.type('#credit-fields input', '3');
    expect(h.$('#credit-fields [role="alert"]')).toBeNull();
    expect(h.$<HTMLButtonElement>('#settings-save')?.disabled).toBe(false);
  });

  it('switching to credit mode asks "unit price from X to Y" per course (X, Y = core in both modes); confirming switches the main screen and keeps consumed + remaining = tuition', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass });
    const [a, b] = h.$$<HTMLInputElement>('#credit-fields input');
    await h.type(`#${a.id}`, '4');
    await h.type(`#${b.id}`, '1');
    const click = async (sel: string) => {
      const el = h.$<HTMLInputElement>(sel)!;
      await act(async () => el.click());
      await h.settle();
    };
    await click('input[name="settings-mode"][value="credit"]');
    await h.click('#settings-save');
    const dialog = h.$('#rate-dialog');
    expect(dialog, 'no confirmation dialog').not.toBeNull();

    const codes = (config.value.courses ?? []).map((c) => c.code);
    const credits: Record<string, number> = { [codes[0] as string]: 4, [codes[1] as string]: 1 };
    const dur = ratesOf('duration', credits);
    const cre = ratesOf('credit', credits);
    const lines = h.$$('#rate-changes li').map((li) => li.textContent);
    // every semester x every course: one line with the duration price and the credit price from core
    expect(lines.length).toBe(cre.built.reduce((n, p) => n + new Set(p.sessions.map((s) => s.courseId)).size, 0));
    for (const p of cre.built) {
      const dp = dur.built.find((x) => x.key === p.key)!;
      for (const courseId of new Set(p.sessions.map((s) => s.courseId))) {
        const from = rateText(dp.sessions.find((s) => s.courseId === courseId)!.ratePerSec, 'HKD');
        const to = rateText(p.sessions.find((s) => s.courseId === courseId)!.ratePerSec, 'HKD');
        expect(lines.some((l) => l?.includes(`单价将从 ${from} 变为 ${to} / 秒`)), `${p.key} ${courseId}: ${from} -> ${to}`).toBe(true);
      }
    }
    await h.click('#rate-dialog-ok');
    await flushSaves();
    expect(config.value.billingMode).toBe('credit');
    expect(h.server.puts('config').at(-1)?.json).toMatchObject({ doc: { billingMode: 'credit' } });

    // the main screen now shows the credit-mode unit price of the class in progress
    await act(async () => {
      location.hash = '#/';
    });
    await h.settle();
    const live = cre.built.flatMap((p) => p.sessions).find((s) => s.id === CLASS_ID)!;
    expect(h.field('rate-per-sec')).toBe(rateText(live.ratePerSec, 'HKD'));
    expect(h.field('rate-per-sec')).not.toBe(rateText(dur.built.flatMap((p) => p.sessions).find((s) => s.id === CLASS_ID)!.ratePerSec, 'HKD'));

    // consumed + remaining == tuition at many instants, in the new mode
    for (let i = 0; i < 60; i++) {
      const now = hk('2026-09-01T00:00:00') + i * 170_000_000;
      const st = billingStateAt(statePools.value, now);
      expect(st.consumedMinor + st.remainingMinor).toBe(st.tuitionMinor);
    }
    nowOverride.value = NOWS.inClass;
  });

  it('credits typed in duration mode change no price: saved at once, without the confirmation dialog', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday });
    const [a] = h.$$<HTMLInputElement>('#credit-fields input');
    await h.type(`#${a.id}`, '5');
    await h.click('#settings-save');
    expect(h.$('#rate-dialog')).toBeNull(); // credits do not change any price in duration mode
    await flushSaves();
    expect(config.value.courses?.[0].credits).toBe(5);
  });
});
