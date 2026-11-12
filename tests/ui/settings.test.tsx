// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { buildPools } from '../../src/core/billing';
import { rateText } from '../../src/state/dashboard';
import { billableSessions, billingConfigOf } from '../../src/state/derived';
import { settingsView } from '../../src/state/settings';
import { boot, flushSaves, teardown } from './harness';
import { fixtureConfig } from '../state/fixture-app';

afterEach(teardown);

describe('settings page', () => {
  it('shows the saved settings: a tuition field per semester, currency, period, dates, calendar list, time note', async () => {
    const h = await boot({ path: '/settings' });
    expect(h.$('#nav-settings')?.getAttribute('aria-current')).toBe('page');
    expect(h.$('h1')?.textContent).toBe('设置');
    expect(h.$$<HTMLInputElement>('#pool-fields input').map((i) => i.value)).toEqual(['398,000.00', '398,000.00']);
    expect(h.$$('#pool-fields li').map((li) => li.getAttribute('data-pool-key'))).toEqual(['2026-S1', '2026-S2']);
    expect(h.$<HTMLInputElement>('#settings-year-start')?.value).toBe('08-01');
    expect(h.$<HTMLInputElement>('#settings-split-date')?.value).toBe('12-25');
    expect(h.$<HTMLInputElement>('input[name="settings-period"]:checked')?.value).toBe('semester');
    expect(h.$<HTMLInputElement>('input[name="settings-currency"]:checked')?.value).toBe('HKD');
    expect(h.$('#settings-calendar-list')?.textContent).toContain('full-term.ics');
    expect(h.$('#card-time')?.textContent).toContain('自动对时');
    expect((h.$<HTMLButtonElement>('#settings-save') as HTMLButtonElement).disabled).toBe(true); // nothing changed yet
    expect(h.$('#settings-split-checks')?.textContent).toContain('分割日');
  });

  it('changing the tuition: the dialog says "unit price will change from X to Y" with core\'s prices; cancel sends nothing, confirm sends', async () => {
    const h = await boot({ path: '/settings' });
    await h.type('#pool-tuition-2026-S1', '440000');
    await h.type('#pool-tuition-2026-S2', '440000');
    expect(h.$('#settings-state')?.textContent).toBe('有尚未保存的修改');
    await h.click('#settings-save');

    const dialog = h.$('#rate-dialog')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const view = settingsView.value;
    const newPools = buildPools(billableSessions.value, billingConfigOf(view.candidate));
    const oldRate = 'HK$1.2708';
    const newRate = rateText(newPools[0].averageRatePerSec, 'HKD');
    expect(h.$('#rate-changes')?.textContent).toContain(`2026 学年 · 第 1 学期：单价将从 ${oldRate} 变为 ${newRate} / 秒`);
    expect(dialog.textContent).toContain('已消耗 + 剩余仍等于学费');
    expect(document.activeElement?.id).toBe('rate-dialog-cancel'); // focus starts on the safe choice
    expect(h.server.puts('config')).toHaveLength(0);

    await h.click('#rate-dialog-cancel');
    expect(h.$('#rate-dialog')).toBeNull();
    expect(h.server.puts('config')).toHaveLength(0);
    expect(h.$<HTMLInputElement>('#pool-tuition-2026-S1')?.value).toBe('440000'); // the typed values are still there

    await h.click('#settings-save');
    await h.key('#rate-dialog', 'Escape'); // Escape cancels as well
    expect(h.$('#rate-dialog')).toBeNull();
    expect(h.server.puts('config')).toHaveLength(0);

    await h.click('#settings-save');
    await h.click('#rate-dialog-ok');
    await flushSaves();
    expect(h.$('#rate-dialog')).toBeNull();
    const puts = h.server.puts('config');
    expect(puts).toHaveLength(1);
    expect((puts[0].json as { doc: { tuition: unknown } }).doc.tuition).toEqual({ defaultMinor: 39_800_000, byPool: { '2026-S1': 44_000_000, '2026-S2': 44_000_000 } });
    expect(h.$('#settings-state')?.textContent).toBe('所有修改都已保存');
  });

  it('a single changed semester gets the plain sentence "单价将从 X 变为 Y / 秒" as the dialog heading', async () => {
    const h = await boot({ path: '/settings' });
    await h.type('#pool-tuition-2026-S2', '500000');
    await h.click('#settings-save');
    const heading = h.$('#rate-dialog-title')?.textContent ?? '';
    expect(heading).toMatch(/^单价将从 HK\$1\.2708 变为 HK\$\d\.\d{4} \/ 秒$/);
    await h.click('#rate-dialog-cancel');
  });

  it('a semester without tuition says "未设置学费" and the other semester is not affected', async () => {
    const cfg = fixtureConfig();
    const h = await boot({ path: '/settings', configOverride: { ...cfg, tuition: { defaultMinor: 39_800_000, byPool: { '2026-S2': null } } } });
    const second = h.$('#pool-fields li[data-pool-key="2026-S2"]')!;
    expect(second.getAttribute('data-unset')).toBe('true');
    expect(second.textContent).toContain('未设置学费');
    expect(second.textContent).toContain('填写后才会开始计价');
    expect(h.$<HTMLInputElement>('#pool-tuition-2026-S2')?.value).toBe('');
    const first = h.$('#pool-fields li[data-pool-key="2026-S1"]')!;
    expect(first.getAttribute('data-unset')).toBe('false');
    expect(h.$<HTMLInputElement>('#pool-tuition-2026-S1')?.value).toBe('398,000.00');
    // the shell points to it from every page
    await h.click('#nav-dashboard');
    expect(h.$('#unset-banner')?.textContent).toContain('第 2 学期');
    expect(h.$('#unset-banner a')?.getAttribute('href')).toBe('#/settings');
  });

  it('invalid input is explained and cannot be saved', async () => {
    const h = await boot({ path: '/settings' });
    await h.type('#settings-split-date', '99-99');
    expect(h.$('#card-academic [role="alert"]')?.textContent).toContain('月-日');
    expect((h.$<HTMLButtonElement>('#settings-save') as HTMLButtonElement).disabled).toBe(true);
    // the tuition fields do not disappear while a date is half typed
    expect(h.$$('#pool-fields li')).toHaveLength(2);
    await h.type('#pool-tuition-2026-S1', 'abc');
    expect(h.$('#pool-note-2026-S1')?.textContent).toContain('大于 0');
    await h.click('#settings-revert');
    expect(h.$<HTMLInputElement>('#settings-split-date')?.value).toBe('12-25');
    expect(h.$<HTMLInputElement>('#pool-tuition-2026-S1')?.value).toBe('398,000.00');
  });

  it('a change that does not move any price saves without the dialog', async () => {
    const h = await boot({ path: '/settings' });
    await h.type('#settings-split-date', '12-30');
    await h.click('#settings-save');
    await flushSaves();
    expect(h.$('#rate-dialog')).toBeNull();
    expect(h.server.puts('config')).toHaveLength(1);
  });

  it('re-importing a calendar from the page replaces it and reports the marks that were kept', async () => {
    const marked = { 'ft-mon-s1@fixture|2026-11-09T01:00:00Z': { status: 'skipped' } };
    const h = await boot({ path: '/settings', docs: { marks: { marks: marked } } });
    const text = (await import('node:fs')).readFileSync('tests/fixtures/full-term.ics', 'utf8').replace('Corporate Finance', 'Corporate Finance II');
    const input = h.$<HTMLInputElement>('#calendar-reimport-cal-fixture')!;
    expect(input.getAttribute('aria-label')).toContain('full-term.ics');
    const file = new File([text], 'full-term-v2.ics', { type: 'text/calendar' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    const { act } = await import('preact/test-utils');
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await h.settle();
    await h.settle();
    expect(h.$('#replace-result')?.textContent).toMatch(/已重新导入：课节 \d+ → \d+ 节，1 个标记保持不变/);
    expect(h.$('#settings-calendar-list')?.textContent).toContain('full-term-v2.ics');
    expect(h.server.calls.some((c) => c.method === 'DELETE' && c.url === '/api/calendars/cal-fixture')).toBe(true);
    // the page's marks are untouched
    expect(h.server.docs.marks.marks).toEqual(marked);
  });
});
