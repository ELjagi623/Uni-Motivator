// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billingStateAt, buildPools, summarizeMarks } from '../../src/core/billing';
import { checkSplitDate } from '../../src/core/academic';
import { groupSessions } from '../../src/core/courses';
import { COPY_LIBRARIES, pickCopy, renderTemplate } from '../../src/core/copy';
import { expandIcs } from '../../src/core/ics/expand';
import { formatMinor } from '../../src/core/money';
import type { Intensity } from '../../src/core/types';
import { DEFAULT_LOCALE, LOCALES, dictionaries, getLocale, setLocale, t } from '../../src/i18n';
import { parseSkipDates } from '../../src/state/manual';
import { fetchBackup } from '../../src/api/client';
import { cancelImport, chooseBackupFile, resetBackupState } from '../../src/state/backup';
import { config, marks } from '../../src/state/data';
import { marksOf, rateText } from '../../src/state/dashboard';
import { billableSessions, billingConfigOf, manualSessions, pools } from '../../src/state/derived';
import { installLanguage } from '../../src/state/language';
import { buildConfig, buildPreview, initialDraft } from '../../src/state/onboarding';
import { SplitChecks } from '../../src/ui/components/SplitChecks';
import { nowOverride } from '../../src/state/now';
import { dashboardInputs } from '../../src/state/dashboardState';
import { boot, flushSaves, teardown, type Harness } from './harness';
import { CLASS_ID, NEXT_CLASS_ID, NOWS, NOWS_Y2, fixtureConfig, fullTermText, hk, nextYearText, twoYearConfig } from '../state/fixture-app';
import { checkI18n, COPY_FILES, DICTIONARIES } from '../../scripts/check-i18n.mjs';

const root = path.resolve(__dirname, '..', '..');
const lateText = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'late-term.ics'), 'utf8');
const MON = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';

let stops: Array<() => void> = [];
beforeEach(() => {
  stops = [];
  localStorage.clear();
  setLocale(DEFAULT_LOCALE);
  resetBackupState();
});
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  teardown();
  setLocale(DEFAULT_LOCALE);
  localStorage.clear();
  vi.restoreAllMocks();
});

const check = async (h: Harness, sel: string) => {
  const el = h.$<HTMLInputElement>(sel);
  expect(el, sel).not.toBeNull();
  await act(async () => el!.click());
  await h.settle();
};

// ------------------------------------------------------------------ 1. manual classes

async function fillWeekly(h: Harness, over: Partial<Record<string, string>> = {}) {
  const v = { name: 'Seminar', start: '14:00', end: '17:00', from: '2026-09-08', to: '2026-12-01', skip: '2026-10-06', ...over };
  await h.click('#manual-open');
  await h.type('#manual-name', v.name);
  await check(h, 'input[name="manual-weekday"][value="2"]');
  await h.type('#manual-start', v.start);
  await h.type('#manual-end', v.end);
  await h.type('#manual-from', v.from);
  await h.type('#manual-to', v.to);
  await h.type('#manual-skip', v.skip);
}

describe('manual classes', () => {
  it('the skipped dates may be separated by spaces, commas, semicolons and their full-width forms', () => {
    const wide = String.fromCharCode(0xff0c);
    expect(parseSkipDates(`2026-10-06${wide}2026-10-13; 2026-10-20 ,2026-10-27`)).toEqual(['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27']);
    expect(parseSkipDates('')).toEqual([]);
  });

  it('a weekly course typed by hand: 12 Tuesday classes, and a "unit price from X to Y, recalculate?" question first (X, Y = core)', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    const oldRate = rateText(pools.value[0].averageRatePerSec, 'HKD');
    await fillWeekly(h);
    await h.click('#manual-submit-weekly');
    // nothing is saved before the user answers
    expect(h.server.puts('marks')).toHaveLength(0);
    expect(manualSessions.value).toHaveLength(0);
    const dialog = h.$('#manual-dialog');
    expect(dialog, 'no question').not.toBeNull();
    // 29 calendar classes of 3 h in 2026 S1 + 12 manual ones of 3 h: 398,000.00 over 41 x 10,800 s
    const newRate = `HK$${(39_800_000 / 100 / (41 * 10_800)).toFixed(4)}`;
    expect(oldRate).toBe('HK$1.2708');
    expect(h.$('#manual-dialog-title')?.textContent).toBe(`2026 学年 · 第 1 学期：单价将从 ${oldRate} 变为 ${newRate} / 秒，是否重算？`);

    await h.click('#manual-dialog-ok');
    await flushSaves();
    const doc = (h.server.puts('marks').at(-1)!.json as { doc: { manual: { weekly: Array<{ weekday: number; skipDates: string[] }> } } }).doc;
    expect(doc.manual.weekly).toHaveLength(1);
    expect(doc.manual.weekly[0]).toMatchObject({ weekday: 2, start: '14:00', end: '17:00', fromDate: '2026-09-08', toDate: '2026-12-01', skipDates: ['2026-10-06'] });
    const cfg = h.server.puts('config').at(-1)!.json as { doc: { courses: Array<{ name: string; manual?: boolean }> } };
    expect(cfg.doc.courses.at(-1)).toMatchObject({ name: 'Seminar', manual: true });
    expect(manualSessions.value).toHaveLength(12);
    expect(manualSessions.value.every((s) => s.source === 'manual' && s.id.startsWith('manual:'))).toBe(true);
    expect(rateText(pools.value[0].averageRatePerSec, 'HKD')).toBe(newRate);
    expect(billableSessions.value.filter((s) => s.id.startsWith('manual:'))).toHaveLength(12);
    expect(h.$('#manual-list li')?.textContent).toContain('Seminar');
  });

  it('cancelling the question writes nothing and adds nothing', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await fillWeekly(h);
    await h.click('#manual-submit-weekly');
    await h.click('#manual-dialog-cancel');
    await flushSaves();
    expect(h.$('#manual-dialog')).toBeNull();
    expect(h.server.puts('marks')).toHaveLength(0);
    expect(h.server.puts('config')).toHaveLength(0);
    expect(manualSessions.value).toHaveLength(0);
  });

  it('mixed with calendar classes, consumed + remaining equals the tuition at every instant', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await fillWeekly(h);
    await h.click('#manual-submit-weekly');
    await h.click('#manual-dialog-ok');
    await flushSaves();
    for (let i = 0; i < 200; i++) {
      const now = hk('2026-08-30T00:00:00') + i * 1_700_000_00 * 1.37;
      const st = billingStateAt(pools.value, now);
      expect(st.consumedMinor + st.remainingMinor).toBe(st.tuitionMinor);
    }
  });

  it('refuses bad input with the reason: reversed times, a date that does not exist, an unknown zone, no name', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await fillWeekly(h, { name: '', start: '17:00', end: '14:00', from: '2026-02-30', zone: 'x' });
    await h.type('#manual-zone', 'Mars/Base');
    await h.click('#manual-submit-weekly');
    const problems = h.$$('#manual-errors li').map((li) => li.getAttribute('data-problem'));
    expect(problems).toEqual(expect.arrayContaining(['title', 'order', 'date', 'zone']));
    expect(h.$('#manual-dialog')).toBeNull();
    expect(h.server.puts('marks')).toHaveLength(0);
  });

  it('a one-off make-up class can be added to an existing course and deleted again, each time asking about the price', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    const before = rateText(pools.value[0].averageRatePerSec, 'HKD');
    await h.click('#manual-open');
    await check(h, 'input[name="manual-tab"][value="single"]');
    await h.type('#manual-date', '2026-11-14');
    await h.type('#manual-start', '10:00');
    await h.type('#manual-end', '12:30');
    await h.click('#manual-submit-single');
    expect(h.$('#manual-dialog')).not.toBeNull();
    await h.click('#manual-dialog-ok');
    await flushSaves();
    expect(manualSessions.value).toHaveLength(1);
    expect(manualSessions.value[0].startMs).toBe(hk('2026-11-14T10:00:00'));
    expect(manualSessions.value[0].id).toMatch(/^manual:c-[a-z0-9]+\|2026-11-14T02:00:00Z$/);
    const added = rateText(pools.value[0].averageRatePerSec, 'HKD');
    expect(added).not.toBe(before);
    // it is in the list; delete it
    expect(h.$$('#manual-list li[data-kind="single"]')).toHaveLength(1);
    await h.click('#manual-list li button');
    expect(h.$('#manual-dialog')).not.toBeNull();
    await h.click('#manual-dialog-ok');
    await flushSaves();
    expect(manualSessions.value).toHaveLength(0);
    expect(rateText(pools.value[0].averageRatePerSec, 'HKD')).toBe(before);
    expect(h.$('#manual-list-none')).not.toBeNull();
  });

  it('a class of a weekly arrangement can be taken out one by one (its date joins the skipped dates)', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await fillWeekly(h);
    await h.click('#manual-submit-weekly');
    await h.click('#manual-dialog-ok');
    await flushSaves();
    const first = manualSessions.value[0];
    // jump to its week and open it
    const { weekChoice } = await import('../../src/state/sessionsState');
    const { weekStartOf } = await import('../../src/state/sessions');
    await act(async () => {
      weekChoice.value = weekStartOf(first.startMs);
    });
    await h.settle();
    await h.click(`tr[data-session-id="${first.id}"] .row-btn`);
    expect(h.$('#manual-remove-this')).not.toBeNull();
    await h.click('#manual-remove-this');
    await h.click('#manual-dialog-ok');
    await flushSaves();
    expect(manualSessions.value).toHaveLength(11);
    const rule = (marks.value.manual as { weekly: Array<{ skipDates: string[] }> }).weekly[0];
    expect(rule.skipDates).toEqual(['2026-10-06', '2026-09-08']);
  });

  it('classes of an archived academic year cannot be added', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS_Y2.inClass, configOverride: twoYearConfig(), texts: [fullTermText, nextYearText] });
    await h.click('#manual-open');
    await check(h, 'input[name="manual-tab"][value="single"]');
    await h.type('#manual-date', '2026-11-14');
    await h.click('#manual-submit-single');
    expect(h.$$('#manual-errors li').map((li) => li.getAttribute('data-problem'))).toEqual(['archived']);
    expect(h.server.puts('marks')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ 2. late / early

describe('late arrival and early leaving', () => {
  const open = async (h: Harness) => {
    await h.click(`tr[data-session-id="${MON}"] .row-btn`);
    expect(h.$('#late-early-box')).not.toBeNull();
  };

  it('minutes in [0, length] are saved; the loss is minutes x 60 x the unit price (= core), in the summary too; nothing else changes', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await open(h);
    const before = pools.value;
    await h.type('#late-late', '10');
    await h.type('#late-early', '20');
    await flushSaves();
    const marksDoc = (h.server.puts('marks').at(-1)!.json as { doc: { marks: Record<string, { lateMin?: number; earlyMin?: number }> } }).doc.marks;
    expect(marksDoc[MON]).toEqual({ lateMin: 10, earlyMin: 20 });
    const ps = pools.value[0].sessions.find((s) => s.id === MON)!;
    expect(h.field('late-loss')).toBe(`约损失 ${formatMinor(Math.round(10 * 60 * ps.ratePerSec), 'HKD')}`);
    expect(h.field('early-loss')).toBe(`约损失 ${formatMinor(Math.round(20 * 60 * ps.ratePerSec), 'HKD')}`);
    const core = summarizeMarks(pools.value, marksOf(marks.value), { asOfMs: NOWS.doneToday }).total;
    expect(core.lateMinutes).toBe(10);
    expect(core.earlyMinutes).toBe(20);
    expect(h.field('late-early-amount')).toBe(formatMinor(core.lateMinor + core.earlyMinor, 'HKD'));
    expect(core.lateMinor + core.earlyMinor).toBeGreaterThan(0);
    // billing does not even look at marks: same pools, invariant intact
    expect(pools.value).toBe(before);
    for (let i = 0; i < 60; i++) {
      const st = billingStateAt(pools.value, hk('2026-09-01T00:00:00') + i * 170_000_000);
      expect(st.consumedMinor + st.remainingMinor).toBe(st.tuitionMinor);
    }
    // attendance is per class: arriving late still counts as attended
    expect(core.attendanceRate).toBe(1);
  });

  it('values outside [0, length], not whole numbers, or adding up to more than the class are refused with a reason and not saved', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await open(h);
    const puts = h.server.puts('marks').length;
    for (const bad of ['181', '999', '-5', 'abc', '1.5']) {
      await h.type('#late-late', bad);
      expect(h.$('#late-error')?.textContent, bad).toBe('请填 0 到 180 之间的整数分钟，迟到加早退不能超过课节长度。');
      expect(h.$('#late-late')?.getAttribute('aria-invalid')).toBe('true');
    }
    await h.type('#late-late', '180'); // the whole class is allowed
    expect(h.$('#late-error')).toBeNull();
    await h.type('#late-early', '1'); // but then nothing is left for leaving early
    expect(h.$('#late-error')).not.toBeNull();
    await flushSaves();
    const doc = (h.server.puts('marks').at(-1)!.json as { doc: { marks: Record<string, { lateMin?: number; earlyMin?: number }> } }).doc.marks;
    expect(doc[MON]).toEqual({ lateMin: 180 });
    expect(h.server.puts('marks').length).toBeGreaterThan(puts);
    // clearing the field removes the mark
    await h.type('#late-late', '');
    await flushSaves();
    expect((h.server.puts('marks').at(-1)!.json as { doc: { marks: Record<string, unknown> } }).doc.marks[MON]).toBeUndefined();
  });

  it('a class marked as skipped has no late / early time', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await h.click(`tr[data-session-id="${MON}"] .row-btn`);
    await h.click('#mark-skip');
    expect(h.$('#late-early-box')).toBeNull();
    expect(h.$('#late-none')).not.toBeNull();
  });
});

// ------------------------------------------------------------------ 3. split date

describe('split-date check with one-click adoption', () => {
  const lateConfig = () => {
    const c = buildConfig({ ...initialDraft(), tuitionText: '398000' }, groupSessions(expandIcs(lateText)), [{ id: 'cal-fixture', name: 'late-term.ics' }]);
    if (!c) throw new Error('config');
    return c;
  };

  it('classes run past 12-25: the settings say where the winter break is and suggest a date; "adopt" sets it and recalculates', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday, configOverride: lateConfig(), texts: [lateText] });
    const sessions = expandIcs(lateText);
    const check26 = checkSplitDate(sessions, { yearStart: '08-01', splitDate: '12-25', billingPeriod: 'semester' }).find((c) => c.year === 2026)!;
    expect(check26.status).toBe('suggest');
    const text = h.$('#settings-split-checks li')?.textContent ?? '';
    expect(text).toContain('检测到你的寒假是 12-28 至 01-18');
    expect(text).toContain(`建议把分割日改为 ${check26.suggestedSplit}`);
    const before = pools.value.map((p) => [p.key, p.sessions.length]);
    expect(before).toEqual([['2026-S1', 16], ['2026-S2', 16]]); // Dec 28 is still in the second semester

    await h.click('#settings-split-checks-adopt-2026');
    // the price changes (the semesters hold other classes now): the usual preview comes first
    expect(h.$('#rate-dialog')).not.toBeNull();
    await h.click('#rate-dialog-ok');
    await flushSaves();
    expect(config.value.academic?.splitDate).toBe(check26.suggestedSplit);
    expect(pools.value.map((p) => [p.key, p.sessions.length])).toEqual([['2026-S1', 17], ['2026-S2', 15]]);
    expect(h.$('#settings-split-checks li')?.textContent).toContain('落在寒假里');
    expect(h.$('#settings-split-checks button')).toBeNull();
  });

  it('adopting changes which semester a class belongs to (Dec 28 moves to the first semester) and the unit prices follow', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday, configOverride: lateConfig(), texts: [lateText] });
    const sessions = expandIcs(lateText);
    const poolsBefore = billableSessions.value.length;
    expect(poolsBefore).toBe(32);
    const dec28 = hk('2026-12-28T09:00:00');
    const poolOf = () => pools.value.find((p) => p.sessions.some((s) => s.startMs === dec28))!.key;
    expect(poolOf()).toBe('2026-S2');
    await h.click('#settings-split-checks-adopt-2026');
    await h.click('#rate-dialog-ok');
    await flushSaves();
    expect(poolOf()).toBe('2026-S1');
    expect(sessions.length).toBe(32);
  });

  it('in the first-run preview the same suggestion has an adopt button; adopting turns the check into "ok" and recalculates the prices', async () => {
    const sessions = expandIcs(lateText);
    const groups = groupSessions(sessions);
    const draft = { ...initialDraft(), tuitionText: '398000' };
    const preview = buildPreview(draft, sessions, groups);
    const suggest = preview.splitChecks.find((c) => c.year === 2026)!;
    expect(suggest.status).toBe('suggest');
    expect(suggest.suggestedSplit).toBe('01-07');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const adopted: string[] = [];
    await act(async () => render(<SplitChecks checks={preview.splitChecks} id="x" onAdopt={(v) => adopted.push(v)} />, host));
    expect(host.querySelector('li')?.textContent).toContain('建议把分割日改为 01-07');
    await act(async () => host.querySelector<HTMLButtonElement>('#x-adopt-2026')!.click());
    expect(adopted).toEqual(['01-07']);
    const after = buildPreview({ ...draft, splitDate: adopted[0] }, sessions, groups);
    expect(after.splitChecks.find((c) => c.year === 2026)!.status).toBe('ok');
    expect(after.pools.map((p) => p.sessions)).toEqual([17, 15]);
    expect(preview.pools.map((p) => p.sessions)).toEqual([16, 16]);
    // inside the break (or with nothing to suggest) there is no button
    await act(async () => render(<SplitChecks checks={after.splitChecks} id="y" onAdopt={() => undefined} />, host));
    expect(host.querySelector('button')).toBeNull();
    render(null, host);
    host.remove();
  });

  it('the split date is already inside the winter break: no suggestion, no button', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday });
    expect(h.$$('#settings-split-checks li').map((li) => li.getAttribute('data-status'))).toEqual(['ok']);
    expect(h.$('#settings-split-checks button')).toBeNull();
  });
});

// ------------------------------------------------------------------ 4. backup (page half)

describe('backup in the settings', () => {
  it('export -> change the tuition -> import brings the tuition back (after a confirmation that names what it replaces)', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday });
    const originalTuition = config.value.tuition?.defaultMinor;
    expect(originalTuition).toBe(39_800_000);
    // export: the page asks the server and offers the text as a download
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:test';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    await h.click('#backup-export');
    expect(h.server.calls.some((c) => c.method === 'GET' && c.url === '/api/export')).toBe(true);
    expect(click).toHaveBeenCalled();
    expect(h.$('#backup-status')?.textContent).toBe('已导出备份文件：tuition-ticker-backup-2026-11-12.json');
    const { text } = await fetchBackup();
    const exported = JSON.parse(text) as { schemaVersion: number; config: { tuition: { defaultMinor: number } }; calendars: unknown[] };
    expect(exported.schemaVersion).toBe(1);
    expect(exported.calendars).toHaveLength(1);

    // change the tuition through the settings page
    await h.type('#pool-tuition-2026-S1', '100');
    await h.click('#settings-save');
    await h.click('#rate-dialog-ok');
    await flushSaves();
    expect(h.server.docs.config.tuition).not.toEqual(exported.config.tuition);

    // import the exported file: a confirmation first, nothing sent yet
    await act(async () => {
      await chooseBackupFile({ name: 'backup.json', text: async () => text });
    });
    await h.settle();
    expect(h.$('#backup-dialog-title')?.textContent).toBe('导入会替换当前所有数据，确定吗？');
    expect(h.server.calls.some((c) => c.method === 'POST' && c.url === '/api/import')).toBe(false);
    await h.click('#backup-dialog-ok');
    await h.settle();
    expect(h.server.calls.filter((c) => c.method === 'POST' && c.url === '/api/import')).toHaveLength(1);
    expect(config.value.tuition).toEqual(exported.config.tuition);
    expect(h.$('#backup-status')?.textContent).toContain('已导入备份');
    expect(h.$<HTMLInputElement>('#pool-tuition-2026-S1')?.value).toBe('398,000.00');
  });

  it('refuses files that are not this program\'s backup (not JSON, wrong marker, unknown schemaVersion) before anything is sent', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday });
    const pick = async (body: string) => {
      await act(async () => {
        await chooseBackupFile({ name: 'x.json', text: async () => body });
      });
      await h.settle();
    };
    await pick('not json');
    expect(h.$('#backup-status')?.textContent).toBe('这不是本软件导出的备份文件。');
    await pick(JSON.stringify({ hello: 1 }));
    expect(h.$('#backup-status')?.textContent).toBe('这不是本软件导出的备份文件。');
    await pick(JSON.stringify({ app: 'tuition-ticker', kind: 'backup', schemaVersion: 9 }));
    expect(h.$('#backup-status')?.textContent).toBe('备份文件的版本（9）本软件不支持。');
    expect(h.$('#backup-dialog')).toBeNull();
    expect(h.server.calls.some((c) => c.url === '/api/import')).toBe(false);
    cancelImport();
  });
});

// ------------------------------------------------------------------ 5. languages

const CJK = /[㐀-鿿]/;

function visibleText(host: HTMLElement): string {
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input[name="settings-language"]').forEach((n) => n.closest('label')?.remove());
  clone.querySelectorAll('.sr-only, script, style').forEach((n) => n.remove());
  return clone.textContent ?? '';
}

describe('languages', () => {
  it('the three dictionaries have exactly the same keys and placeholders, and the copy libraries are complete (check:i18n)', () => {
    const dict = Object.fromEntries(DICTIONARIES.map(({ locale, file }: { locale: string; file: string }) => [locale, fs.readFileSync(path.join(root, file), 'utf8')]));
    const copy = Object.fromEntries(COPY_FILES.map(({ locale, file }: { locale: string; file: string }) => [locale, fs.readFileSync(path.join(root, file), 'utf8')]));
    expect(checkI18n(dict, copy)).toEqual([]);
    // and the same from the running objects
    const keys = (l: 'zh-CN' | 'zh-TW' | 'en') => Object.keys(dictionaries[l]).sort();
    expect(keys('zh-TW')).toEqual(keys('zh-CN'));
    expect(keys('en')).toEqual(keys('zh-CN'));
  });

  it('the check notices a missing key, an extra key and a changed placeholder', () => {
    const dict = Object.fromEntries(DICTIONARIES.map(({ locale, file }: { locale: string; file: string }) => [locale, fs.readFileSync(path.join(root, file), 'utf8')]));
    const copy = Object.fromEntries(COPY_FILES.map(({ locale, file }: { locale: string; file: string }) => [locale, fs.readFileSync(path.join(root, file), 'utf8')]));
    const broken = { ...dict, en: dict.en.replace("  'app.retry': 'Retry',\n", "  'app.extra': 'x',\n").replace("'{n} / {total}'", "'{n} / {all}'") };
    const problems = checkI18n(broken, copy);
    expect(problems).toEqual(expect.arrayContaining(['en: missing key app.retry', 'en: extra key app.extra']));
    expect(problems.some((p) => p.includes('placeholders of onboarding.stepOfTotal'))).toBe(true);
  });

  it('a key missing in a language falls back to zh-CN without an error', () => {
    const en = dictionaries.en as Record<string, string>;
    const saved = en['app.retry'];
    delete en['app.retry'];
    try {
      setLocale('en');
      expect(t('app.retry')).toBe('重试');
      expect(t('app.title')).toBe('Tuition Ticker');
    } finally {
      en['app.retry'] = saved;
    }
  });

  it('switching to English and to Traditional Chinese changes the page text and <html lang> at once; the choice is saved and mirrored', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.doneToday });
    stops.push(installLanguage());
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(h.$('h1')?.textContent).toBe('设置');
    await check(h, 'input[name="settings-language"][value="en"]');
    expect(document.documentElement.lang).toBe('en');
    expect(h.$('h1')?.textContent).toBe('Settings');
    expect(h.$('#nav-sessions')?.textContent).toBe('Classes');
    await check(h, 'input[name="settings-language"][value="zh-TW"]');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(h.$('h1')?.textContent).toBe('設定');
    await check(h, 'input[name="settings-language"][value="en"]');
    await flushSaves();
    expect((h.server.puts('config').at(-1)!.json as { doc: { language: string } }).doc.language).toBe('en');
    expect(localStorage.getItem('tt.lang')).toBe('en');
    expect(getLocale()).toBe('en');
  });

  it('the saved language is used again after a reload (config -> locale and <html lang>)', async () => {
    const cfg = { ...fixtureConfig(), language: 'en' as const };
    const h = await boot({ path: '/', nowMs: NOWS.inClass, configOverride: cfg });
    stops.push(installLanguage());
    await h.settle();
    expect(document.documentElement.lang).toBe('en');
    expect(h.$('#status-pill')?.textContent).toContain('In class');
    expect(h.$('#nav-settings')?.textContent).toBe('Settings');
    // a config without a language means zh-CN again
    const h2 = await boot({ path: '/', nowMs: NOWS.inClass });
    stops.push(installLanguage());
    await h2.settle();
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(h2.$('#nav-settings')?.textContent).toBe('设置');
  });

  for (const [locale, page, now] of [
    ['en', '/', NOWS.inClass],
    ['en', '/sessions', NOWS.doneToday],
    ['en', '/stats', NOWS.doneToday],
    ['en', '/settings', NOWS.doneToday],
    ['en', '/', NOWS.afterTerm],
    ['en', '/', NOWS.beforeTerm],
  ] as const) {
    it(`in English the ${page} page (${now === NOWS.inClass ? 'in class' : 'another state'}) shows no Chinese characters at all`, async () => {
      setLocale(locale);
      const h = await boot({ path: page, nowMs: now, docs: { marks: { marks: { [MON]: { status: 'skipped' } } } } });
      if (page === '/sessions') await h.click(`tr[data-session-id="${CLASS_ID}"] .row-btn`);
      const text = visibleText(h.host);
      expect(text.match(CJK), `Chinese text left: ${text.match(/.{0,12}[㐀-鿿]+.{0,12}/)?.[0]}`).toBeNull();
      expect(text.length).toBeGreaterThan(50);
    });
  }

  it('dates and equivalents follow the language too (skip calculator and slack hint in English use English item names)', async () => {
    setLocale('en');
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await h.click(`tr[data-session-id="${CLASS_ID}"] .row-btn`);
    expect(h.field('skip-calc')).toMatch(/^Skipping this class = throwing away HK\$13,724\.14 ≈ 304 boxes of three-dish rice$/);
    setLocale('zh-TW');
    const h2 = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    await h2.click(`tr[data-session-id="${CLASS_ID}"] .row-btn`);
    expect(h2.field('skip-calc')).toBe('翹掉這節 = 扔掉 HK$13,724.14 ≈ 304 盒三餸飯');
  });
});

// ------------------------------------------------------------------ 6. copy intensity

describe('copy intensity', () => {
  const vars = { course: 'MFIN7001', amount: 'HK$100.00', rate: 'HK$1.27', minutes: 7, count: 3, unit: '盒', item: '三餸饭' };

  for (const level of ['gentle', 'normal', 'extreme'] as const) {
    it(`${level}: 50 draws in a row all come from that tier's lines and never repeat the previous one (every language)`, () => {
      for (const locale of LOCALES) {
        const lib = COPY_LIBRARIES[locale][level];
        const allowed = new Set(lib['in-class'].map((tpl) => renderTemplate(tpl, vars)).filter((x): x is string => x !== null));
        expect(allowed.size).toBeGreaterThan(5);
        let previous: string | null = null;
        let seed = 7;
        const random = () => {
          seed = (seed * 16807) % 2147483647;
          return seed / 2147483647;
        };
        for (let i = 0; i < 50; i++) {
          const line = pickCopy({ intensity: level, locale, scene: 'in-class', vars, previous, random });
          expect(line, `${locale} ${level}`).not.toBeNull();
          expect(allowed.has(line as string), `${locale} ${level}: ${line}`).toBe(true);
          expect(line).not.toBe(previous);
          previous = line;
        }
      }
    });
  }

  it('the tiers are different sets of lines', () => {
    const sets = (['gentle', 'normal', 'extreme'] as Intensity[]).map((l) => new Set(COPY_LIBRARIES['zh-CN'][l]['in-class']));
    for (const a of sets) for (const b of sets) if (a !== b) for (const line of a) expect(b.has(line)).toBe(false);
  });

  it('the settings offer the three tiers, save the choice in the config, and the lines on the home screen switch to the new tier at once', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass });
    expect(h.$$('input[name="settings-intensity"]').map((i) => i.parentElement?.textContent)).toEqual(['温和', '正常', '焦虑拉满']);
    expect(h.$<HTMLInputElement>('input[name="settings-intensity"][value="normal"]')!.checked).toBe(true);
    const lineOn = async (level: Intensity) => {
      await check(h, `input[name="settings-intensity"][value="${level}"]`);
      await flushSaves();
      expect((h.server.puts('config').at(-1)!.json as { doc: { intensity: string } }).doc.intensity).toBe(level);
      expect(config.value.intensity).toBe(level);
      await act(async () => {
        location.hash = '#/';
      });
      await h.settle();
      const text = h.$('#copy-line')?.textContent ?? '';
      const options = COPY_LIBRARIES['zh-CN'][level]['in-class'];
      const ok = options.some((tpl) => {
        const re = new RegExp(`^${tpl.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+')}$`);
        return re.test(text);
      });
      expect(ok, `${level}: "${text}"`).toBe(true);
      await act(async () => {
        location.hash = '#/settings';
      });
      await h.settle();
    };
    await lineOn('extreme');
    await lineOn('gentle');
    await lineOn('normal');
  });
});

// ------------------------------------------------------------------ 7. B3 carry-overs

describe('carry-overs from the B3 test', () => {
  const marksTwoYears = { marks: { [CLASS_ID]: { status: 'skipped' }, [NEXT_CLASS_ID]: { status: 'cancelled' } } };

  it('the summary cards of the session list follow the year of the shown week and say so ("汇总范围：2027 学年")', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS_Y2.inClass, configOverride: twoYearConfig(), texts: [fullTermText, nextYearText], docs: { marks: marksTwoYears } });
    const inputs = dashboardInputs.value;
    const per = (year: number) => summarizeMarks(inputs.pools.filter((p) => p.year === year), inputs.marks, { asOfMs: NOWS_Y2.inClass }).total;
    // the current year: the cancelled class of 2027 is in the cards, the skipped class of 2026 is not
    expect(h.field('summary-scope')).toContain('汇总范围：2027 学年');
    expect(h.field('cancelled-amount')).toBe(formatMinor(per(2027).cancelledMinor, 'HKD'));
    expect(h.field('skipped-amount')).toBe(formatMinor(per(2027).skippedMinor, 'HKD'));
    expect(per(2027).skippedMinor).toBe(0);
    await h.click('.year-chip[data-year="2026"]');
    expect(h.field('summary-scope')).toContain('汇总范围：2026 学年');
    expect(h.field('skipped-amount')).toBe(formatMinor(per(2026).skippedMinor, 'HKD'));
    expect(per(2026).skippedMinor).toBeGreaterThan(0);
    expect(h.field('cancelled-amount')).toBe(formatMinor(per(2026).cancelledMinor, 'HKD'));
  });

  it('with a single academic year there is no scope line (the cards cover everything)', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.doneToday });
    expect(h.field('summary-scope')?.trim().startsWith('汇总范围')).toBe(false);
  });

  it('the end-of-term screen offers "生成分享卡", which leads to the statistics page where the card is made', async () => {
    const h = await boot({ path: '/', nowMs: NOWS.afterTerm });
    const link = h.$<HTMLAnchorElement>('#share-link');
    expect(link?.textContent).toBe('生成分享卡');
    expect(link?.getAttribute('href')).toBe('#/stats');
    await act(async () => {
      link!.click();
    });
    await act(async () => {
      location.hash = '#/stats';
    });
    await h.settle();
    expect(h.$('#share-panel')).not.toBeNull();
    expect(h.$<HTMLButtonElement>('#share-generate')?.disabled).toBe(false);
  });

  it('credits: blank counts as 1, a bad value cannot be saved, and saving recalculates the unit prices (= core)', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass });
    const [a, b] = h.$$<HTMLInputElement>('#credit-fields input');
    await h.type(`#${a.id}`, '0');
    expect(h.$<HTMLButtonElement>('#settings-save')?.disabled).toBe(true);
    await h.type(`#${a.id}`, '3');
    await h.type(`#${b.id}`, '');
    expect(h.$<HTMLButtonElement>('#settings-save')?.disabled).toBe(false);
    await check(h, 'input[name="settings-mode"][value="credit"]');
    await h.click('#settings-save');
    expect(h.$('#rate-dialog')).not.toBeNull();
    await h.click('#rate-dialog-ok');
    await flushSaves();
    expect(config.value.courses?.map((c) => c.credits)).toEqual([3, null]);
    expect(config.value.billingMode).toBe('credit');
    const cfg = config.value;
    const expected = buildPools(billableSessions.value, billingConfigOf(cfg));
    expect(pools.value.map((p) => p.sessions.map((s) => s.ratePerSec))).toEqual(expected.map((p) => p.sessions.map((s) => s.ratePerSec)));
    // 3 credits against the blank course (= 1 credit): the first course gets 3/4 of the tuition
    const first = pools.value[0].sessions.find((s) => s.courseId === cfg.courses![0].id)!;
    const seconds = pools.value[0].sessions.filter((s) => s.courseId === first.courseId).reduce((n, s) => n + s.durationSec, 0);
    expect(first.ratePerSec * seconds).toBeCloseTo((39_800_000 * 3) / 4, 4);
    nowOverride.value = NOWS.inClass;
  });
});
