// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPoolOfSession, getPoolSession, poolStateAt, sessionStateAt } from '../../src/core/billing';
import { groupSessions } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';
import { formatAmountMinor } from '../../src/core/money';
import { slackAmountMinor } from '../../src/core/slack';
import { getStatus } from '../../src/core/status';
import { calendars, flushSaves, loadAll, resetDataState } from '../../src/state/data';
import { resetCalendarState } from '../../src/state/calendars';
import { chooseSession } from '../../src/state/dashboardState';
import { getDemoData } from '../../src/state/demo';
import { demoActive, demoData } from '../../src/state/demoState';
import { buildConfig, draft, initialDraft } from '../../src/state/onboarding';
import { slackUi, startSlackWatcher } from '../../src/state/slack';
import { nowOverride } from '../../src/state/now';
import { startTitleUpdates } from '../../src/state/title';
import { App } from '../../src/ui/App';
import { installFakeServer, type FakeServer } from '../state/fake-server';
import { CLASS_END, CLASS_ID, CLASS_START, NOWS, fixtureConfig, fullTermText, inputsFor } from '../state/fixture-app';

let server: FakeServer;
let host: HTMLDivElement;
let stops: Array<() => void> = [];

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const field = (name: string) => $(`[data-field="${name}"]`)?.textContent ?? null;
const status = () => $('#dashboard')?.getAttribute('data-status') ?? null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(sel: string): Promise<void> {
  const el = $<HTMLButtonElement>(sel);
  expect(el, sel).not.toBeNull();
  await act(async () => {
    el!.click();
  });
  await settle();
}

async function boot(options: { nowMs?: number | null; docs?: Parameters<typeof installFakeServer>[0]; texts?: string[]; configOverride?: ReturnType<typeof fixtureConfig> } = {}): Promise<void> {
  const config = options.configOverride ?? fixtureConfig();
  const texts = options.texts ?? [fullTermText];
  for (const stop of stops) stop();
  stops = [];
  render(null, host);
  server?.restore();
  server = installFakeServer({ config: config as unknown as Record<string, unknown>, ...options.docs }, texts.map((text, i) => ({ id: `cal-${i}`, text })));
  await loadAll();
  nowOverride.value = options.nowMs === undefined ? NOWS.inClass : options.nowMs;
  stops = [startSlackWatcher(), startTitleUpdates()];
  await act(async () => {
    render(<App />, host);
  });
  await settle();
}

beforeEach(() => {
  resetDataState();
  resetCalendarState();
  draft.value = initialDraft();
  demoActive.value = false;
  demoData.value = null;
  slackUi.value = null;
  chooseSession(null);
  nowOverride.value = null;
  document.title = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  render(null, host);
  host.remove();
  server?.restore();
  nowOverride.value = null;
});

describe('dashboard: six states', () => {
  it.each([
    ['beforeTerm', 'before-term'],
    ['inClass', 'in-class'],
    ['break', 'break'],
    ['doneToday', 'done-today'],
    ['noClassToday', 'no-class-today'],
    ['afterTerm', 'after-term'],
  ] as const)('at the %s instant the page shows %s, the state core reports', async (name, kind) => {
    const nowMs = NOWS[name];
    await boot({ nowMs });
    const inputs = inputsFor(fixtureConfig(), [fullTermText]);
    expect(getStatus(nowMs, inputs.sessions, {}).kind).toBe(kind);
    expect(status()).toBe(kind);
    expect($('#status-pill')?.textContent?.trim()).toBeTruthy();
  });

  it('in class: course, session i of N, unit price, consumed / remaining and the tank equal core', async () => {
    await boot({ nowMs: NOWS.inClass });
    const inputs = inputsFor(fixtureConfig(), [fullTermText]);
    const pool = findPoolOfSession(inputs.pools, CLASS_ID)!;
    const st = sessionStateAt(pool, CLASS_ID, NOWS.inClass)!;
    const ps = poolStateAt(pool, NOWS.inClass);

    expect(field('course')).toBe('MFIN7002 Investment Analysis');
    expect(field('session-index')).toBe('第 10 / 14 节');
    expect(field('rate-per-sec')).toBe('HK$1.2708');
    expect(getPoolSession(pool, CLASS_ID)!.ratePerSec).toBeCloseTo(127.0754, 3);
    expect(field('session-consumed')).toBe(formatAmountMinor(st.consumedMinor));
    expect(field('session-remaining')).toBe(formatAmountMinor(st.remainingMinor));
    expect(field('pool-consumed')).toBe(formatAmountMinor(ps.consumedMinor));
    expect(field('pool-remaining')).toBe(formatAmountMinor(ps.remainingMinor));
    expect(field('elapsed')).toBe('00:30:00');
    expect(field('time-left')).toBe('02:30:00');
    // consumed + remaining of the tank is the tuition, to the cent
    const cents = (text: string | null) => Math.round(Number((text ?? '').replace(/,/g, '')) * 100);
    expect(cents(field('pool-consumed')) + cents(field('pool-remaining'))).toBe(39_800_000);
    // the layout has the timeline, the tank, a copy line and the slack button
    expect($('#timeline')).not.toBeNull();
    expect($('#tank')).not.toBeNull();
    expect($('#copy-line')?.textContent).toBeTruthy();
    expect($('#slack-btn')).not.toBeNull();
  });

  it('break shows the countdown and the next class cost; no slack button outside class', async () => {
    await boot({ nowMs: NOWS.break });
    expect(field('countdown')).toBe('02:00:00');
    expect(field('next-cost')).toBe('HK$13,724.14');
    expect($('#slack-btn')).toBeNull();
  });

  it('before the term shows days until the first class and the tuition; after the term shows the summary', async () => {
    await boot({ nowMs: NOWS.beforeTerm });
    expect(field('days-until-term')).toBe('14 天');
    expect(field('pool-tuition')).toBe('398,000.00');
    await boot({ nowMs: NOWS.afterTerm });
    expect(status()).toBe('after-term');
    expect(field('pool-tuition')).toBe('796,000.00');
  });

  it('overlapping classes get a switch button that changes the class on display', async () => {
    const overlapText = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', 'UID:a@t', 'DTSTART:20261112T020000Z', 'DTEND:20261112T050000Z', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:AAAA1000 First', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b@t', 'DTSTART:20261112T030000Z', 'DTEND:20261112T060000Z', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:BBBB2000 Second', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const cfg = buildConfig({ ...initialDraft(), tuitionText: '60000', billingPeriod: 'year' }, groupSessions(expandIcs(overlapText)), [{ id: 'cal-0', name: 'x' }])!;
    await boot({ nowMs: Date.parse('2026-11-12T03:30:00Z'), texts: [overlapText], configOverride: cfg });
    expect(status()).toBe('in-class');
    expect(field('course')).toContain('AAAA1000');
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('.overlap button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('BBBB2000');
    await click('.overlap button');
    expect(field('course')).toContain('BBBB2000');
  });
});

describe('slacking lifecycle', () => {
  it('writes the record with PUT slacks first, and only then shows the slacking page', async () => {
    await boot({ nowMs: NOWS.inClass });
    const pageAtPut: boolean[] = [];
    server.onCall = (call) => {
      if (call.method === 'PUT' && call.url === '/api/docs/slacks') pageAtPut.push($('#slack-page') !== null);
    };
    expect($('#slack-page')).toBeNull();
    await click('#slack-btn');

    const puts = server.puts('slacks');
    expect(puts).toHaveLength(1);
    expect(pageAtPut).toEqual([false]); // the request left before the page switched
    expect($('#slack-page')).not.toBeNull();
    const records = (puts[0].json as { doc: { records: Array<Record<string, unknown>> } }).doc.records;
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]).sort()).toEqual(['id', 'sessionId', 'startMs']); // no amount is stored
    expect(records[0]).toMatchObject({ sessionId: CLASS_ID, startMs: NOWS.inClass });
    expect(typeof records[0].id).toBe('string');
  });

  it('restores an unfinished slacking session after a reload, with the amount for the time that has passed', async () => {
    const startMs = NOWS.inClass;
    const nowMs = startMs + 5 * 60_000;
    await boot({ nowMs, docs: { slacks: { records: [{ id: 'r1', sessionId: CLASS_ID, startMs }] } } });
    expect($('#slack-page')).not.toBeNull();
    const inputs = inputsFor(fixtureConfig(), [fullTermText]);
    const rate = getPoolSession(findPoolOfSession(inputs.pools, CLASS_ID)!, CLASS_ID)!.ratePerSec;
    const expected = slackAmountMinor({ id: 'r1', sessionId: CLASS_ID, startMs }, { id: CLASS_ID, startMs: CLASS_START, endMs: CLASS_END }, rate, nowMs);
    expect(field('slack-amount')).toBe(formatAmountMinor(expected));
    expect(field('slack-duration')).toBe('00:05:00');
    expect(document.title).toBe(`🐟 HK$${formatAmountMinor(expected)}`);
    expect(server.puts('slacks')).toHaveLength(0); // restoring changes nothing on disk
  });

  it('closes a record whose class is over at the end time of the class', async () => {
    await boot({ nowMs: CLASS_END + 10 * 60_000, docs: { slacks: { records: [{ id: 'r1', sessionId: CLASS_ID, startMs: NOWS.inClass }] } } });
    expect($('#slack-page')).toBeNull();
    await flushSaves();
    const stored = (server.docs.slacks.records as Array<{ endMs?: number }>)[0];
    expect(stored.endMs).toBe(CLASS_END);
  });

  it('turns the slacking page into the settlement card when the class ends meanwhile', async () => {
    await boot({ nowMs: CLASS_END - 60_000, docs: { slacks: { records: [{ id: 'r1', sessionId: CLASS_ID, startMs: CLASS_END - 120_000 }] } } });
    expect($('#slack-page')).not.toBeNull();
    await act(async () => {
      nowOverride.value = CLASS_END + 1000;
    });
    await settle();
    expect($('#slack-page')).toBeNull();
    expect($('#settlement')).not.toBeNull();
    await flushSaves();
    expect((server.docs.slacks.records as Array<{ endMs?: number }>)[0].endMs).toBe(CLASS_END);
  });

  it('"continue the lecture" writes endMs and shows the settlement card with the amount core gives', async () => {
    await boot({ nowMs: NOWS.inClass });
    await click('#slack-btn');
    const startMs = NOWS.inClass;
    const endNow = startMs + 12 * 60_000;
    await act(async () => {
      nowOverride.value = endNow;
    });
    await click('#continue-btn');

    expect($('#slack-page')).toBeNull();
    expect($('#settlement')).not.toBeNull();
    const put = server.puts('slacks').at(-1)!;
    const rec = (put.json as { doc: { records: Array<{ id: string; endMs?: number }> } }).doc.records[0];
    expect(rec.endMs).toBe(endNow);

    const inputs = inputsFor(fixtureConfig(), [fullTermText]);
    const rate = getPoolSession(findPoolOfSession(inputs.pools, CLASS_ID)!, CLASS_ID)!.ratePerSec;
    const expected = slackAmountMinor({ id: rec.id, sessionId: CLASS_ID, startMs, endMs: endNow }, { id: CLASS_ID, startMs: CLASS_START, endMs: CLASS_END }, rate, endNow);
    expect(field('settle-amount')).toBe(formatAmountMinor(expected));
    expect(field('settle-duration')).toBe('12 分 00 秒');
    expect(field('settle-total')).toBe('12 分钟');
    expect($('[data-field="settle-equivalent"]')?.textContent).toBeTruthy();

    await click('#settle-close');
    expect($('#settlement')).toBeNull();
    expect(status()).toBe('in-class');
    expect(field('slack-today-amount')).toBe(`HK$${formatAmountMinor(expected)}`);
  });
});

describe('slacking at zero', () => {
  it('with nothing wasted yet the equivalent line does not say "a bit more and you could buy ..." and the settlement has no equivalent row', async () => {
    await boot({ nowMs: NOWS.inClass });
    await click('#slack-btn');
    expect(field('slack-amount')).toBe('0.00');
    expect(field('slack-equivalent')).toBe('才刚开始，现在回去听课，一分钱都还没浪费');
    expect(field('slack-equivalent')).not.toContain('再浪费一点');
    await click('#continue-btn');
    expect(field('settle-amount')).toBe('0.00');
    expect($('[data-field="settle-equivalent"]')).toBeNull();
  });
});

describe('tab title, screen readers, demo mode', () => {
  it('shows "HK$2,287 · MFIN7002" in class and "🐟 HK$x.xx" while slacking, and the app name otherwise', async () => {
    await boot({ nowMs: NOWS.inClass });
    expect(document.title).toMatch(/^HK\$[\d,]+ · \S+/);
    expect(document.title).toBe('HK$2,287 · MFIN7002');
    await click('#slack-btn');
    expect(document.title).toMatch(/^🐟 HK\$\d[\d,]*\.\d{2}/);
    await click('#continue-btn');
    await click('#settle-close');
    expect(document.title).toBe('HK$2,287 · MFIN7002'); // back to the in-class title (frozen test time)
    await boot({ nowMs: NOWS.break });
    expect(document.title).toBe('学费计价器');
  });

  it('has an aria-live="polite" summary that changes at most once in 60 seconds; ticking numbers are not live', async () => {
    await boot({ nowMs: NOWS.inClass }); // 10:30:00 sharp, so 10:30:00-10:30:59 is one minute
    const live = $('#live-summary')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('MFIN7002');
    let changes = 0;
    const observer = new MutationObserver((records) => {
      changes += records.length;
    });
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    for (let s = 1; s <= 59; s++) {
      await act(async () => {
        nowOverride.value = NOWS.inClass + s * 1000;
      });
    }
    await settle();
    expect(changes).toBe(0);
    for (let s = 60; s <= 119; s++) {
      await act(async () => {
        nowOverride.value = NOWS.inClass + s * 1000;
      });
    }
    await settle();
    expect(changes).toBeLessThanOrEqual(1);
    observer.disconnect();

    for (const el of host.querySelectorAll('[data-field][aria-hidden="true"]')) expect(el.closest('[aria-live]')).toBeNull();
    expect(host.querySelectorAll('[aria-live]').length).toBe(1);
  });

  it('demo mode shows an in-class dashboard from the sample timetable without writing anything, and exits to the wizard', async () => {
    await boot({ nowMs: null, configOverride: { schemaVersion: 1 } as ReturnType<typeof fixtureConfig>, texts: [] });
    expect($('#onboarding')).not.toBeNull();
    const before = { rev: server.docs.config.rev, calls: server.calls.length };
    await click('#demo-btn');
    expect(status()).toBe('in-class');
    expect($('#demo-banner')).not.toBeNull();
    expect(calendars.value).toHaveLength(0); // real state untouched
    expect(getDemoData().calendars).toHaveLength(1);

    await click('#slack-btn'); // slacking inside the demo
    expect($('#slack-page')).not.toBeNull();
    await click('#continue-btn');
    expect($('#settlement')).not.toBeNull();
    await click('#settle-close');

    await flushSaves();
    expect(server.docs.config.rev).toBe(before.rev);
    expect(server.calls.length).toBe(before.calls); // no request at all
    expect(server.puts()).toHaveLength(0);

    await click('#demo-exit');
    expect($('#onboarding')).not.toBeNull();
    expect($('#dashboard')).toBeNull();
    expect($('#slack-page')).toBeNull();
  });
});
