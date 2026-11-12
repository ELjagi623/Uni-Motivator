import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { calendars, config, flushSaves, loadAll, marks, resetDataState, subscriptions } from '../../src/state/data';
import { pools } from '../../src/state/derived';
import { marksOf } from '../../src/state/dashboard';
import { setMark } from '../../src/state/marks';
import { rateText } from '../../src/state/dashboard';
import { resetCalendarState, settingsCalendars } from '../../src/state/calendars';
import { clearSyncReport, lastSyncText, subscribe, syncErrorText, syncNow, syncRateText, syncReport } from '../../src/state/subscriptions';
import { installFakeServer, type FakeServer } from './fake-server';
import { fixtureConfig, fullTermText } from './fixture-app';
import fs from 'node:fs';
import path from 'node:path';

const changedText = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'full-term-changed.ics'), 'utf8');
const LINK = 'http://source.invalid/term.ics';
let server: FakeServer;

beforeEach(async () => {
  resetDataState();
  resetCalendarState();
  clearSyncReport();
  server = installFakeServer({ config: fixtureConfig() as unknown as Record<string, unknown> }, [{ id: 'cal-fixture', text: fullTermText }]);
  server.sources.set(LINK, fullTermText);
  await loadAll();
});

afterEach(() => {
  server.restore();
});

const MON = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';
const s1 = () => pools.value.find((p) => p.key === '2026-S1')!;

describe('subscription sync (page side)', () => {
  it('adding a link: the server downloads it, the calendar shows up as a subscription, the link is not kept in the page', async () => {
    const report = await subscribe(` ${LINK} `);
    expect(report.status).toBe('ok');
    expect(calendars.value.map((c) => c.id)).toEqual(['cal-fixture', 'sub-1']);
    expect(subscriptions.value).toHaveLength(1);
    expect(JSON.stringify(subscriptions.value)).not.toContain('source.invalid');
    const row = settingsCalendars.value.find((c) => c.id === 'sub-1')!;
    expect(row.subscription).not.toBeNull();
    expect(row.name).toBe('订阅日历');
    // the same classes as the imported file: same session ids, so nothing is counted twice and no price moves
    expect(report.rateChanges).toEqual([]);
    expect(lastSyncText(row.subscription!, row.subscription!.lastSyncMs! + 30_000)).toBe('刚刚');
    expect(syncReport.value).toBe(report);
  });

  it('a changed source: "unit price changed from X to Y" with core\'s old and new price, and the marks stay', async () => {
    await subscribe(LINK);
    // drop the file copy so the subscription is the only source of the timetable
    await fetch('/api/calendars/cal-fixture', { method: 'DELETE', headers: { 'X-Tuition-Ticker': '1' } });
    calendars.value = calendars.value.filter((c) => c.id !== 'cal-fixture');
    setMark(MON, 'skipped');
    await flushSaves();
    const before = s1();
    const oldText = rateText(before.averageRatePerSec, 'HKD');
    expect(oldText).toBe('HK$1.2708');

    server.sources.set(LINK, changedText); // one Thursday less and one Monday moved by the school
    const report = await syncNow('sub-1');
    expect(report.status).toBe('ok');
    expect(report.changed).toBe(true);
    const after = s1();
    const newText = rateText(after.averageRatePerSec, 'HKD');
    expect(newText).not.toBe(oldText);
    expect(after.sessions.length).toBe(before.sessions.length - 1);
    const change = report.rateChanges.find((c) => c.poolKey === '2026-S1')!;
    expect(change.fromText).toBe(oldText);
    expect(change.toText).toBe(newText);
    expect(syncRateText(change)).toBe(`2026 学年 · 第 1 学期：单价从 ${oldText} 变为 ${newText} / 秒`);
    // consumed + remaining is still the pool's tuition, and the mark is still on its session
    expect(marksOf(marks.value)[MON]).toEqual({ status: 'skipped' });
    expect(after.tuitionMinor).toBe(39_800_000);
  });

  it('an unchanged source reports "no change" and no price change', async () => {
    await subscribe(LINK);
    const report = await syncNow('sub-1');
    expect(report).toMatchObject({ status: 'ok', changed: false, rateChanges: [] });
  });

  it('a source that is down: an error report, the calendar and the data stay as they were', async () => {
    await subscribe(LINK);
    const textBefore = calendars.value.find((c) => c.id === 'sub-1')!.text;
    const poolsBefore = pools.value;
    server.down.add(LINK);
    const report = await syncNow('sub-1');
    expect(report).toMatchObject({ status: 'error', errorCode: 'network', changed: false, rateChanges: [] });
    expect(syncErrorText('network')).toBe('连不上订阅源');
    expect(calendars.value.find((c) => c.id === 'sub-1')!.text).toBe(textBefore);
    expect(pools.value.map((p) => p.averageRatePerSec)).toEqual(poolsBefore.map((p) => p.averageRatePerSec));
    expect(subscriptions.value[0].lastError).toBe('network'); // the page can show "last sync failed"
    expect(syncReport.value?.status).toBe('error');
    // and it recovers
    server.down.delete(LINK);
    expect((await syncNow('sub-1')).status).toBe('ok');
    expect(subscriptions.value[0].lastError).toBeNull();
  });

  it('a bad link or an unreachable local service gives a readable error and stores nothing', async () => {
    expect(await subscribe('ftp://x/y.ics')).toMatchObject({ status: 'error', errorCode: 'bad_url' });
    expect(syncErrorText('bad_url')).toContain('http');
    expect(subscriptions.value).toEqual([]);
    expect(await subscribe('http://never-heard-of-it.invalid/a.ics')).toMatchObject({ status: 'error', errorCode: 'network' });
    expect(calendars.value.map((c) => c.id)).toEqual(['cal-fixture']);
    server.restore();
    const gone = await syncNow('sub-1');
    expect(gone).toMatchObject({ status: 'error', errorCode: 'unreachable' });
    expect(config.value.onboardingDone).toBe(true);
  });

  it('says when the last sync was', () => {
    const at = 1_000_000_000_000;
    expect(lastSyncText({ lastSyncMs: at }, at + 10_000)).toBe('刚刚');
    expect(lastSyncText({ lastSyncMs: at }, at + 5 * 60_000)).toBe('5 分钟前');
    expect(lastSyncText({ lastSyncMs: at }, at + 3 * 3_600_000)).toBe('3 小时前');
    expect(lastSyncText({ lastSyncMs: at }, at + 2 * 86_400_000)).toBe('2 天前');
    expect(lastSyncText({ lastSyncMs: at }, at - 5000)).toBe('刚刚'); // a fake "now" before the sync
    expect(lastSyncText({ lastSyncMs: null }, at)).toBe('还没有同步过');
  });
});
