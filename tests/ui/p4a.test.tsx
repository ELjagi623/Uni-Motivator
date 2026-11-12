// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMinor } from '../../src/core/money';
import { computeStats } from '../../src/core/stats';
import { nowOverride } from '../../src/state/now';
import { permission } from '../../src/state/reminders';
import { boot, flushSaves, teardown } from './harness';
import { CLASS_END, CLASS_ID, CLASS_START, NOWS, fixtureConfig, fullTermText, hk, inputsFor } from '../state/fixture-app';

const root = path.resolve(__dirname, '..', '..');
const MON = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';
const slackDocs = {
  slacks: { records: [{ id: 'r1', sessionId: MON, startMs: hk('2026-11-09T10:00:00'), endMs: hk('2026-11-09T10:20:00') }] },
  marks: { marks: { 'ft-mon-s1@fixture|2026-11-02T01:00:00Z': { status: 'skipped' } } },
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  teardown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ skip calculator

describe('skip calculator in the session detail', () => {
  it('shows "throw away HK$x = n boxes of three-dish rice" from core\'s numbers, and nothing for a cancelled class', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await h.click(`tr[data-session-id="${CLASS_ID}"] .row-btn`);
    expect(h.$('#skip-calc .label')?.textContent).toBe('翘课计算器');
    // HK$13,724.14 / HK$45 = 304.98 boxes
    expect(h.field('skip-calc')).toBe('翘掉这节 = 扔掉 HK$13,724.14 ≈ 304 盒三餸饭');
    await h.click('#mark-cancel');
    expect(h.$('#skip-calc')).toBeNull();
    await h.click('#mark-cancel');
    expect(h.$('#skip-calc')).not.toBeNull();
  });
});

// ------------------------------------------------------------------ statistics page

describe('statistics page', () => {
  it('shows the course ranking, the slacking figures and the period summaries from core, drawn as SVG', async () => {
    const h = await boot({ path: '/stats', nowMs: NOWS.doneToday, docs: slackDocs });
    const inputs = inputsFor(fixtureConfig(), [fullTermText], {
      marks: slackDocs.marks.marks as never,
      slacks: slackDocs.slacks.records,
    });
    const stats = computeStats({ ...inputs, nowMs: NOWS.doneToday });
    expect(h.$('h1')?.textContent).toBe('统计');
    const rows = h.$$('#courses-table tbody tr');
    expect(rows).toHaveLength(stats.courses.length);
    stats.courses.forEach((c, i) => {
      expect(rows[i].getAttribute('data-course-id')).toBe(c.courseId);
      expect(rows[i].querySelector('[data-field="course-cost"]')?.textContent).toBe(formatMinor(c.totalCostMinor, 'HKD'));
      expect(rows[i].querySelector('[data-field="course-per-hour"]')?.textContent).toBe(`${formatMinor(c.costPerHourMinor, 'HKD')} / 小时`);
    });
    expect(h.field('slack-total')).toBe(formatMinor(stats.slack.totalMinor, 'HKD'));
    expect(stats.slack.totalMinor).toBeGreaterThan(0);
    expect(h.field('slack-longest')).toContain('20 分钟');
    expect(h.field('expensive-cost')).toBe(formatMinor(stats.mostExpensive!.costMinor, 'HKD'));
    expect(h.field('lossy-cost')).toBe(formatMinor(stats.mostLossy!.costMinor, 'HKD'));
    expect(h.field('period-semester-spent')).toBe(formatMinor(stats.totalCostMinor, 'HKD'));

    // the charts are SVG elements, with a bar per course / week
    const courses = h.$('#courses-chart')!;
    expect(courses.tagName.toLowerCase()).toBe('svg');
    expect(courses.getAttribute('role')).toBe('img');
    expect(courses.querySelectorAll('rect.chart__bar')).toHaveLength(stats.courses.length);
    const weekly = h.$('#weekly-chart')!;
    expect(weekly.tagName.toLowerCase()).toBe('svg');
    expect(weekly.querySelectorAll('rect.chart__bar').length).toBeGreaterThan(5);
    expect(weekly.querySelectorAll('rect.chart__slack')).toHaveLength(1); // the one week with slacking
  });

  it('uses no chart library', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    expect(names.filter((n) => /chart|d3|plotly|recharts|echarts|victory|visx|nivo/i.test(n))).toEqual([]);
  });

  it('before any class there is a plain message instead of empty charts', async () => {
    const h = await boot({ path: '/stats', nowMs: NOWS.beforeTerm });
    expect(h.$('#stats-empty')?.textContent).toContain('还没有下课');
    expect(h.$('#courses-chart')).toBeNull();
    expect(h.$('#share-generate')).not.toBeNull(); // the share panel is still there
  });

  it('is reached from the navigation, and the "term finished" screen links to it', async () => {
    const h = await boot({ path: '/', nowMs: NOWS.afterTerm });
    expect(h.$('#nav-stats')?.getAttribute('href')).toBe('#/stats');
    expect(h.$('#share-link')?.getAttribute('href')).toBe('#/stats');
    await h.click('#share-link');
    expect(h.$('#stats')).not.toBeNull();
    expect(h.$('#nav-stats')?.getAttribute('aria-current')).toBe('page');
  });
});

// ------------------------------------------------------------------ share card (page)

function stubCanvas() {
  const drawn: string[] = [];
  const ctx = new Proxy({ fillText: (t: string) => drawn.push(t) } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : () => undefined),
    set: (target, key: string, value) => {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
    const bytes = new Uint8Array(40);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, this.width);
    view.setUint32(20, this.height);
    cb(new Blob([bytes], { type: 'image/png' }));
  });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test-card', revokeObjectURL: () => undefined }));
  return drawn;
}

describe('share card on the statistics page', () => {
  it('"生成分享卡" makes a 1080 x 1440 PNG that can be saved as a .png file, without the school name', async () => {
    const drawn = stubCanvas();
    const h = await boot({ path: '/stats', nowMs: NOWS.doneToday, docs: slackDocs, configOverride: { ...fixtureConfig(), school: 'TESTSCHOOL' } });
    expect(h.$('#share-download')).toBeNull();
    await h.click('#share-generate');
    await h.settle();
    const link = h.$<HTMLAnchorElement>('#share-download')!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('download')).toMatch(/^tuition-ticker-\d{4}-\d{2}-\d{2}\.png$/);
    expect(link.getAttribute('href')).toBe('blob:test-card');
    expect(h.$('#share-preview')?.getAttribute('alt')).toBe('分享卡片预览');
    expect(drawn.join('\n')).not.toContain('TESTSCHOOL');
    expect(drawn.join('\n')).toMatch(/HK\$/);
    expect(drawn.length).toBeGreaterThan(8);
  });

  it('a failing canvas shows a message instead of breaking the page', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const h = await boot({ path: '/stats', nowMs: NOWS.doneToday });
    await h.click('#share-generate');
    expect(h.$('#share-error')?.textContent).toContain('生成图片失败');
    expect(h.$('#share-download')).toBeNull();
  });
});

// ------------------------------------------------------------------ reminders

function stubNotification(state: 'granted' | 'denied' | 'default') {
  const calls: Array<{ title: string; body: string }> = [];
  function Stub(this: unknown, title: string, options?: NotificationOptions) {
    calls.push({ title, body: options?.body ?? '' });
  }
  Stub.permission = state;
  Stub.requestPermission = vi.fn(async () => {
    Stub.permission = 'granted';
    return 'granted' as NotificationPermission;
  });
  vi.stubGlobal('Notification', Stub);
  permission.value = state;
  return { calls, Stub };
}

const setNow = async (ms: number) => {
  await act(async () => {
    nowOverride.value = ms;
  });
};

describe('class reminders', () => {
  it('granted: one notification N minutes before the class and one at the end (with the slack minutes and money), never repeated', async () => {
    const { calls } = stubNotification('granted');
    const h = await boot({
      path: '/settings',
      nowMs: CLASS_START - 20 * 60_000,
      docs: { slacks: { records: [{ id: 'r1', sessionId: CLASS_ID, startMs: CLASS_START + 3_600_000, endMs: CLASS_START + 3_600_000 + 12 * 60_000 }] } },
    });
    await h.click('#card-reminders input[type="checkbox"]');
    await flushSaves();
    expect(h.server.docs.config.reminders).toEqual({ enabled: true, leadMinutes: 5 });
    expect(calls).toHaveLength(0);

    await setNow(CLASS_START - 5 * 60_000 - 1000);
    expect(calls).toHaveLength(0);
    await setNow(CLASS_START - 5 * 60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain('MFIN7002');
    expect(calls[0].body).toContain('5 分钟后开始');
    expect(calls[0].body).toContain('HK$13,724.14');
    await setNow(CLASS_START - 4 * 60_000);
    await setNow(CLASS_START - 60_000);
    expect(calls).toHaveLength(1); // not again

    await setNow(CLASS_END);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toContain('MFIN7002 下课了');
    expect(calls[1].body).toContain('HK$13,724.14');
    expect(calls[1].body).toContain('摸鱼 12 分钟');
    expect(calls[1].body).toMatch(/浪费 HK\$\d/);
    await setNow(CLASS_END + 30_000);
    expect(calls).toHaveLength(2);
    expect(h.$('#reminder-toasts')).toBeNull(); // with permission there is no in-page copy
  });

  it('denied: the notification stub is never called, the reminder shows inside the page with a note', async () => {
    const { calls } = stubNotification('denied');
    const h = await boot({ path: '/settings', nowMs: CLASS_START - 20 * 60_000 });
    expect(h.$('#notify-permission')?.getAttribute('data-permission')).toBe('denied');
    expect(h.$('#notify-permission')?.textContent).toContain('已被拒绝');
    await h.click('#card-reminders input[type="checkbox"]');
    await setNow(CLASS_START - 5 * 60_000);
    await h.settle();
    expect(calls).toHaveLength(0);
    const toast = h.$('#reminder-toasts')!;
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('MFIN7002');
    expect(toast.textContent).toContain('HK$13,724.14');
    expect(toast.textContent).toContain('没有允许通知');
    await h.click('#reminder-toasts button');
    expect(h.$('#reminder-toasts')).toBeNull();
  });

  it('the lead time can be changed in the settings and works at once', async () => {
    const { calls } = stubNotification('granted');
    const h = await boot({ path: '/settings', nowMs: CLASS_START - 30 * 60_000 });
    await h.click('#card-reminders input[type="checkbox"]');
    await h.click('input[name="reminder-lead"][value="15"]');
    await flushSaves();
    expect(h.server.docs.config.reminders).toEqual({ enabled: true, leadMinutes: 15 });
    await setNow(CLASS_START - 16 * 60_000);
    expect(calls).toHaveLength(0);
    await setNow(CLASS_START - 15 * 60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain('15 分钟后开始');
  });

  it('off by default, switchable off again, silent for cancelled classes, and the first switch-on asks for permission', async () => {
    const { calls, Stub } = stubNotification('default');
    const h = await boot({ path: '/settings', nowMs: CLASS_START - 10 * 60_000, docs: { marks: { marks: { [CLASS_ID]: { status: 'cancelled' } } } } });
    await setNow(CLASS_START - 5 * 60_000);
    expect(calls).toHaveLength(0); // not enabled yet
    await h.click('#card-reminders input[type="checkbox"]');
    expect(Stub.requestPermission).toHaveBeenCalledTimes(1);
    expect(h.$('#notify-permission')?.getAttribute('data-permission')).toBe('granted');
    await setNow(CLASS_START - 4 * 60_000);
    expect(calls).toHaveLength(0); // the class is cancelled: nobody is going
  });

  it('without the Notification API the settings say so and reminders stay in the page', async () => {
    vi.stubGlobal('Notification', undefined);
    permission.value = 'unsupported';
    const h = await boot({ path: '/settings', nowMs: CLASS_START - 20 * 60_000 });
    expect(h.$('#notify-permission')?.textContent).toContain('不支持通知');
    await h.click('#card-reminders input[type="checkbox"]');
    await setNow(CLASS_START - 5 * 60_000);
    await h.settle();
    expect(h.$('#reminder-toasts')?.textContent).toContain('MFIN7002');
  });
});

// ------------------------------------------------------------------ subscriptions (page)

describe('subscription controls in the settings', () => {
  it('adds a link, lists the subscription with "last synced", syncs on demand and reports a price change', async () => {
    const changed = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'full-term-changed.ics'), 'utf8');
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass });
    h.server.sources.set('http://feed.invalid/a.ics', fullTermText);
    await h.type('#subscribe-url', 'http://feed.invalid/a.ics');
    await h.click('#subscribe-add');
    await h.settle();
    expect(h.$('#sync-result')?.getAttribute('data-status')).toBe('ok');
    expect(h.$('#subscribe-url')).not.toBeNull();
    expect(h.$<HTMLInputElement>('#subscribe-url')?.value).toBe(''); // the link is not kept on the page
    const row = h.$('#settings-calendar-list li[data-calendar-id="sub-1"]')!;
    expect(row.textContent).toContain('订阅日历');
    expect(row.textContent).toContain('上次同步：');

    // remove the file copy, change the source, sync
    await h.click('#settings-calendar-list li[data-calendar-id="cal-fixture"] button[aria-label^="移除"]');
    h.server.sources.set('http://feed.invalid/a.ics', changed);
    await h.click('#sync-sub-1');
    await h.settle();
    expect(h.$('#sync-result')?.getAttribute('data-changed')).toBe('true');
    expect(h.$('.sync-rate')?.textContent).toMatch(/^2026 学年 · 第 1 学期：单价从 HK\$1\.2708 变为 HK\$1\.3161 \/ 秒$/);

    // the source goes away: an error, nothing changes
    h.server.down.add('http://feed.invalid/a.ics');
    const sessionsBefore = h.$('#settings-calendar-list li[data-calendar-id="sub-1"]')?.textContent?.match(/\d+ 个事件/)?.[0];
    await h.click('#sync-sub-1');
    await h.settle();
    expect(h.$('#sync-result')?.getAttribute('data-status')).toBe('error');
    expect(h.$('#sync-result')?.textContent).toContain('连不上订阅源');
    expect(h.$('#sync-result')?.textContent).toContain('原有的日历没有改动');
    expect(h.$('[data-field="last-sync-error"]')?.textContent).toContain('连不上订阅源');
    expect(h.$('#settings-calendar-list li[data-calendar-id="sub-1"]')?.textContent).toContain(sessionsBefore as string); // the calendar is as it was
  });
});
