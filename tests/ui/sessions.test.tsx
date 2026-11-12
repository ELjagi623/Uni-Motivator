// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeMarks } from '../../src/core/billing';
import { formatMinor } from '../../src/core/money';
import { marksOf } from '../../src/state/dashboard';
import { pools } from '../../src/state/derived';
import { marks } from '../../src/state/data';
import { boot, flushSaves, teardown } from './harness';
import { CLASS_ID, NOWS } from '../state/fixture-app';

afterEach(teardown);

const MON_ID = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';

describe('session list page', () => {
  it('is reached from the navigation and shows the week of now, the summary and one row per class', async () => {
    const h = await boot({ path: '/' });
    expect(h.$('#nav-sessions')?.getAttribute('href')).toBe('#/sessions');
    expect(h.$('#nav-dashboard')?.getAttribute('aria-current')).toBe('page');
    const h2 = await boot({ path: '/sessions' });
    expect(h2.$('#nav-sessions')?.getAttribute('aria-current')).toBe('page');
    expect(h2.$('h1')?.textContent).toBe('课节列表');
    expect(h2.field('week-label')).toBe('第 46 周 · 11/09 – 11/15');
    const rows = h2.$$('tr.session-row');
    expect(rows.map((r) => r.getAttribute('data-session-id'))).toEqual([MON_ID, CLASS_ID]);
    expect(rows.map((r) => r.getAttribute('data-phase'))).toEqual(['past', 'ongoing']);
    expect(h2.field('cancelled-amount')).toBe('HK$0.00');
    expect(h2.field('skipped-amount')).toBe('HK$0.00');
    expect(h2.field('attendance-rate')).toBe('100%');
  });

  it('marks a class as skipped and another as cancelled: PUT marks, tags with glyph and text, summary from core', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    expect(h.$('#detail-empty')).not.toBeNull();
    await h.click('tr[data-session-id="' + MON_ID + '"] .row-btn');
    expect(h.$('#session-detail')?.getAttribute('data-session-id')).toBe(MON_ID);
    expect(h.field('detail-title')).toBe('MFIN7001 · 11/09 09:00');
    expect(h.$('#mark-state')?.textContent).toBe('当前：没有标记');
    expect(h.$('#mark-skip')?.getAttribute('aria-pressed')).toBe('false');

    await h.click('#mark-skip');
    await flushSaves();
    const marksPut = h.server.puts('marks').at(-1)!;
    expect((marksPut.json as { doc: { marks: Record<string, unknown> } }).doc.marks).toEqual({ [MON_ID]: { status: 'skipped' } });
    const monRow = h.$('tr[data-session-id="' + MON_ID + '"]')!;
    expect(monRow.getAttribute('data-mark')).toBe('skipped');
    expect(monRow.querySelector('.tag')?.textContent).toBe('× 翘课'); // a glyph and words, not just a colour
    expect(h.$('#mark-skip')?.getAttribute('aria-pressed')).toBe('true');
    expect(h.$('#mark-skip')?.textContent).toBe('取消翘课标记');
    expect(h.$('#mark-state')?.textContent).toContain('翘课');

    await h.click('tr[data-session-id="' + CLASS_ID + '"] .row-btn');
    await h.click('#mark-cancel');
    await flushSaves();
    expect(h.$('tr[data-session-id="' + CLASS_ID + '"] .tag')?.textContent).toBe('○ 停课');
    expect(h.$('tr[data-session-id="' + CLASS_ID + '"]')?.getAttribute('data-mark')).toBe('cancelled');

    // the three figures are core's summary at that instant
    const core = summarizeMarks(pools.value, marksOf(marks.value), { asOfMs: NOWS.doneToday }).total;
    expect(core.skippedMinor).toBeGreaterThan(0);
    expect(core.cancelledMinor).toBeGreaterThan(0);
    expect(h.field('skipped-amount')).toBe(formatMinor(core.skippedMinor, 'HKD'));
    expect(h.field('cancelled-amount')).toBe(formatMinor(core.cancelledMinor, 'HKD'));
    expect(h.field('attendance-rate')).toBe(`${Math.round((core.attendanceRate as number) * 100)}%`); // 18 of the 19 classes that count (20 ended, 1 cancelled) = 95%
    expect(core.skippedCount).toBe(1);
    expect(core.cancelledCount).toBe(1);

    // clicking the pressed button takes the mark off again
    await h.click('#mark-cancel');
    await flushSaves();
    expect(h.$('tr[data-session-id="' + CLASS_ID + '"]')?.getAttribute('data-mark')).toBe('');
    expect((h.server.docs.marks.marks as Record<string, unknown>)[CLASS_ID]).toBeUndefined();
  });

  it('the dashboard follows a mark: a cancelled class is not "in class" (the unit price does not change)', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.inClass });
    await h.click('tr[data-session-id="' + CLASS_ID + '"] .row-btn');
    await h.click('#mark-cancel');
    await h.click('#nav-dashboard');
    expect(h.$('#dashboard')).not.toBeNull(); // the link really switched pages
    expect(h.$('#dashboard')?.getAttribute('data-status')).not.toBe('in-class');
    await h.click('#nav-sessions');
    await h.click('tr[data-session-id="' + CLASS_ID + '"] .row-btn');
    expect(h.field('detail-rate')).toBe('HK$1.2708');
  });

  it('week navigation: previous / next / back to this week, with the limits of the calendar disabled', async () => {
    const h = await boot({ path: '/sessions' });
    expect(h.$('#week-today')).toBeNull();
    await h.click('#week-prev');
    expect(h.field('week-label')).toBe('第 45 周 · 11/02 – 11/08');
    expect(h.$('#week-today')).not.toBeNull();
    expect(h.$$('tr.session-row').every((r) => r.getAttribute('data-phase') === 'past')).toBe(true);
    await h.click('#week-today');
    expect(h.field('week-label')).toBe('第 46 周 · 11/09 – 11/15');
    for (let i = 0; i < 40; i++) {
      if ((h.$<HTMLButtonElement>('#week-next') as HTMLButtonElement).disabled) break;
      await h.click('#week-next');
    }
    expect((h.$<HTMLButtonElement>('#week-next') as HTMLButtonElement).disabled).toBe(true);
    expect(h.$$('tr.session-row').every((r) => r.getAttribute('data-phase') === 'upcoming')).toBe(true);
  });

  it('is operable from the keyboard: every row has a real button, the mark controls are buttons with pressed state', async () => {
    const h = await boot({ path: '/sessions' });
    const rowButtons = h.$$<HTMLButtonElement>('tr.session-row .row-btn');
    expect(rowButtons).toHaveLength(2);
    for (const b of rowButtons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('aria-label')).toContain('MFIN700');
      expect(b.hasAttribute('aria-pressed')).toBe(true);
    }
    await h.click('tr.session-row .row-btn');
    for (const id of ['#mark-skip', '#mark-cancel']) {
      const b = h.$<HTMLButtonElement>(id)!;
      expect(b.tagName).toBe('BUTTON');
      expect(b.hasAttribute('aria-pressed')).toBe(true);
      expect(b.tabIndex).toBeGreaterThanOrEqual(0);
    }
    expect(h.$('#mark-state')?.getAttribute('role')).toBe('status');
  });

  it('shows slacking on a past class and the cost of a past class in full', async () => {
    const h = await boot({
      path: '/sessions',
      nowMs: NOWS.doneToday,
      docs: { slacks: { records: [{ id: 'r1', sessionId: MON_ID, startMs: Date.parse('2026-11-09T02:00:00Z'), endMs: Date.parse('2026-11-09T02:10:00Z') }] } },
    });
    expect(h.$('tr[data-session-id="' + MON_ID + '"] [data-field="row-slack"]')?.textContent).toMatch(/^摸鱼 10 分钟 · 浪费 HK\$\d/);
    expect(h.$('tr[data-session-id="' + MON_ID + '"] .c-cost')?.textContent).toBe('HK$13,724.14');
    await h.click('tr[data-session-id="' + CLASS_ID + '"] .row-btn');
    expect(h.field('detail-cost')).toBe('HK$13,724.14');
    expect(h.field('detail-consumed')).toBe('HK$13,724.14');
  });

  it('the demo has no navigation and no sessions page', async () => {
    const h = await boot({ path: '/sessions' });
    const { enterDemo } = await import('../../src/state/demo');
    enterDemo();
    await h.settle();
    expect(h.$('.shell-nav')).toBeNull();
    expect(h.$('#sessions')).toBeNull();
    expect(h.$('#dashboard')).not.toBeNull();
  });
});
