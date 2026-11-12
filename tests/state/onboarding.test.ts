import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPools } from '../../src/core/billing';
import { checkSplitDate } from '../../src/core/academic';
import { courseFromGroup, groupSessions, sessionsOfCourses } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';
import { calendars, config, loadAll, resetDataState } from '../../src/state/data';
import { importFiles, resetCalendarState } from '../../src/state/calendars';
import { allSessions } from '../../src/state/derived';
import {
  addSecondSemester,
  applyRegion,
  buildConfig,
  buildPreview,
  canProceed,
  draft,
  finishOnboarding,
  groups,
  initialDraft,
  nextStep,
  preview,
  removeSecondSemester,
  selectedCourses,
  setGroupSelected,
  tuition2MinorOf,
  tuitionComplete,
  tuitionMinorOf,
  updateDraft,
  chooseRegion,
  type OnboardingDraft,
} from '../../src/state/onboarding';
import { installFakeServer, type FakeServer } from './fake-server';

const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'full-term.ics');
const fullTermText = fs.readFileSync(fixturePath, 'utf8');
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

let server: FakeServer;

beforeEach(async () => {
  resetDataState();
  resetCalendarState();
  draft.value = initialDraft();
  server = installFakeServer();
  await loadAll();
});

afterEach(() => {
  server.restore();
});

const withTuition = (text: string, patch: Partial<OnboardingDraft> = {}): OnboardingDraft => ({ ...initialDraft(), tuitionText: text, ...patch });
const emptyPreview = buildPreview(initialDraft(), [], []);

describe('onboarding: tuition and the next/finish guards', () => {
  it('turns typed major-unit amounts into integer minor units without floating-point error', () => {
    expect(tuitionMinorOf(withTuition('398000.5'))).toBe(39800050);
    expect(tuitionMinorOf(withTuition('398,000'))).toBe(39800000);
    expect(tuitionMinorOf(withTuition('0.07'))).toBe(7);
    expect(tuitionMinorOf(withTuition('19.99'))).toBe(1999);
    expect(Number.isInteger(tuitionMinorOf(withTuition('1234567.89')))).toBe(true);
  });

  it('treats empty, zero and non-numeric tuition as invalid', () => {
    for (const text of ['', '   ', '0', '0.00', 'abc', '-5', '12e3']) expect(tuitionMinorOf(withTuition(text)), JSON.stringify(text)).toBeNull();
  });

  it('blocks step 3 and the final step while the tuition is empty or 0', () => {
    const sessions = expandIcs(fullTermText);
    const g = groupSessions(sessions);
    for (const text of ['', '0']) {
      const d = withTuition(text);
      expect(canProceed(3, d, { calendarCount: 1, preview: buildPreview(d, sessions, g) })).toBe(false);
      expect(canProceed(7, d, { calendarCount: 1, preview: buildPreview(d, sessions, g) })).toBe(false);
    }
    const ok = withTuition('398000');
    expect(canProceed(3, ok, { calendarCount: 1, preview: buildPreview(ok, sessions, g) })).toBe(true);
    expect(canProceed(7, ok, { calendarCount: 1, preview: buildPreview(ok, sessions, g) })).toBe(true);
  });

  it('needs a valid year start and split date on step 4, a calendar on step 5, and a ticked course on step 6', () => {
    const ctx = { calendarCount: 0, preview: emptyPreview };
    expect(canProceed(4, { ...initialDraft(), splitDate: '13-40' }, ctx)).toBe(false);
    expect(canProceed(4, { ...initialDraft(), yearStart: '8-1' }, ctx)).toBe(true);
    expect(canProceed(5, initialDraft(), ctx)).toBe(false);
    expect(canProceed(5, initialDraft(), { ...ctx, calendarCount: 1 })).toBe(true);
    expect(canProceed(6, initialDraft(), ctx)).toBe(false);
    expect(canProceed(1, initialDraft(), ctx)).toBe(true);
    expect(canProceed(2, initialDraft(), ctx)).toBe(true);
  });

  it('nextStep() does not move past step 3 while the tuition is empty', () => {
    updateDraft({ step: 3 });
    nextStep();
    expect(draft.value.step).toBe(3);
    updateDraft({ tuitionText: '398000' });
    nextStep();
    expect(draft.value.step).toBe(4);
  });
});

describe('onboarding: region presets', () => {
  it('fills 09-01 / 12-31 for the northern hemisphere and 01-01 / 07-01 for the southern one', () => {
    const north = applyRegion(initialDraft(), 'northern');
    expect([north.yearStart, north.splitDate]).toEqual(['09-01', '12-31']);
    const south = applyRegion(initialDraft(), 'southern');
    expect([south.yearStart, south.splitDate]).toEqual(['01-01', '07-01']);
    chooseRegion('southern');
    expect([draft.value.yearStart, draft.value.splitDate]).toEqual(['01-01', '07-01']);
  });
});

describe('onboarding: the config that is written', () => {
  const sessions = expandIcs(fullTermText);
  const g = groupSessions(sessions);
  const sources = [{ id: 'cal-1', name: 'full-term.ics' }];

  it('per-semester and per-year billing give different, correct structures', () => {
    const semester = buildConfig(withTuition('398000', { billingPeriod: 'semester', currency: 'HKD', school: ' HKU ' }), g, sources);
    const year = buildConfig(withTuition('398000', { billingPeriod: 'year', currency: 'GBP' }), g, sources);
    expect(semester).toMatchObject({ schemaVersion: 1, onboardingDone: true, school: 'HKU', currency: 'HKD', academic: { yearStart: '09-01', splitDate: '12-31', billingPeriod: 'semester' }, tuition: { defaultMinor: 39800000, byPool: {} }, calendars: sources });
    expect(year).toMatchObject({ currency: 'GBP', academic: { billingPeriod: 'year' }, tuition: { defaultMinor: 39800000 } });
    expect(year?.tuition).not.toHaveProperty('byPool');
    expect(semester?.tuition).not.toEqual(year?.tuition);
  });

  it('stores only the ticked groups as courses, with typed names and credits', () => {
    const d = withTuition('1000', { names: { [g[0].key]: '  My course  ' }, credits: { [g[0].key]: '3' }, selection: { [g[1].key]: false } });
    const cfg = buildConfig(d, g, sources);
    expect(cfg?.courses).toHaveLength(1);
    expect(cfg?.courses?.[0]).toMatchObject({ name: 'My course', credits: 3 });
  });

  it('refuses to build a config without tuition or without a course', () => {
    expect(buildConfig(withTuition(''), g, sources)).toBeNull();
    expect(buildConfig(withTuition('1000', { selection: Object.fromEntries(g.map((x) => [x.key, false])) }), g, sources)).toBeNull();
  });
});

describe('onboarding: importing files and the recognition page', () => {
  it('imports a plain .ics: one POST, events parsed', async () => {
    const report = await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    expect(report).toEqual({ added: 1, duplicates: [], failures: [] });
    expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(server.calls.find((c) => c.method === 'POST')?.headers['x-tuition-ticker']).toBe('1');
    expect(allSessions.value).toHaveLength(58);
  });

  it('imports a .zip: every .ics inside is unzipped in the browser and posted', async () => {
    const zip = zipSync({ 'a/one.ics': strToU8(fullTermText), '__MACOSX/._one.ics': strToU8('junk'), 'readme.txt': strToU8('hi') });
    const report = await importFiles([{ name: 'export.zip', data: zip }]);
    expect(report.added).toBe(1);
    expect(report.failures).toEqual([]);
    expect(allSessions.value).toHaveLength(58);
  });

  it('reports unusable files without throwing or posting them', async () => {
    const report = await importFiles([
      { name: 'notes.txt', data: bytes('hello') },
      { name: 'broken.ics', data: bytes('not a calendar') },
      { name: 'empty.zip', data: zipSync({ 'x.txt': strToU8('x') }) },
    ]);
    expect(report.added).toBe(0);
    expect(report.failures.map((f) => f.reason)).toEqual(['unsupported', 'not-calendar', 'no-ics']);
    expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('importing the same file twice is reported as a duplicate', async () => {
    await importFiles([{ name: 'a.ics', data: bytes(fullTermText) }]);
    const again = await importFiles([{ name: 'b.ics', data: bytes(fullTermText) }]);
    expect(again.added).toBe(0);
    expect(again.duplicates).toEqual(['b.ics']);
    expect(calendars.value).toHaveLength(1);
  });

  it('what is ticked on the recognition page changes the step-7 preview', async () => {
    await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    updateDraft({ tuitionText: '398000' });
    expect(groups.value).toHaveLength(2);
    expect(groups.value.every((x) => x.suggested)).toBe(true);
    expect(preview.value.sessionCount).toBe(58);
    expect(preview.value.hours).toBe('174.0');

    setGroupSelected(groups.value[0].key, false);
    expect(preview.value.sessionCount).toBe(groups.value[1].count);
    expect(preview.value.sessionCount).toBeLessThan(58);

    for (const x of groups.value) setGroupSelected(x.key, false);
    expect(preview.value.sessionCount).toBe(0);
    expect(preview.value.pools).toEqual([]);
    expect(canProceed(6, draft.value, { calendarCount: 1, preview: preview.value })).toBe(false);
  });
});

describe('onboarding: the preview agrees with core', () => {
  it('shows the same counts, hours, cost per second and average per session as an independent core computation', async () => {
    await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    updateDraft({ tuitionText: '398000', billingPeriod: 'semester' });

    const sessions = expandIcs(fullTermText);
    const courses = groupSessions(sessions).filter((x) => x.suggested).map((x, i) => courseFromGroup(x, { colorIndex: i }));
    const billable = sessionsOfCourses(sessions, courses);
    const pools = buildPools(billable, { academic: { yearStart: '08-01', splitDate: '12-25', billingPeriod: 'semester' }, tuition: { defaultMinor: 39800000 } });

    const view = preview.value;
    expect(view.pools).toHaveLength(pools.length);
    pools.forEach((pool, i) => {
      expect(view.pools[i].sessions).toBe(pool.sessions.length);
      expect(view.pools[i].hours).toBe((pool.totalSeconds / 3600).toFixed(1));
      expect(view.pools[i].rate).toBe(`HK$${(39800000 / pool.totalSeconds / 100).toFixed(4)}`);
      expect(view.pools[i].average).toBe(`HK$${(Math.round(39800000 / pool.sessions.length) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    });
    expect(view.pools[0].rate).toBe('HK$1.2708');
    expect(view.rate).toBe('HK$1.2708');
    expect(view.average).toBe('HK$13,724.14');
    expect(view.splitChecks.map((c) => c.status)).toEqual(checkSplitDate(billable, { yearStart: '08-01', splitDate: '12-25', billingPeriod: 'semester' }).map((c) => c.status));
    expect(view.splitChecks[0].status).toBe('ok');
  });

  it('with per-year billing there is one pool carrying the whole tuition', async () => {
    await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    updateDraft({ tuitionText: '398000', billingPeriod: 'year' });
    expect(preview.value.pools).toHaveLength(1);
    expect(preview.value.pools[0]).toMatchObject({ sessions: 58, hours: '174.0', rate: 'HK$0.6354' });
  });

  it('leaves the rate empty (not 0) while the tuition is not valid', async () => {
    await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    updateDraft({ tuitionText: '' });
    expect(preview.value.sessionCount).toBe(58);
    expect(preview.value.rate).toBeNull();
    expect(selectedCourses(draft.value, groups.value)).toHaveLength(2);
  });
});

describe('onboarding: finishing', () => {
  it('writes the finished config to the server at once and leaves the wizard', async () => {
    await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    updateDraft({ tuitionText: '398000', currency: 'HKD', billingPeriod: 'semester', step: 7 });
    expect(await finishOnboarding()).toBe(true);
    const put = server.puts('config');
    expect(put).toHaveLength(1);
    const doc = (put[0].json as { doc: Record<string, unknown> }).doc;
    expect(doc).toMatchObject({ onboardingDone: true, currency: 'HKD', tuition: { defaultMinor: 39800000 }, academic: { billingPeriod: 'semester', splitDate: '12-31' }, language: 'en' });
    expect(Array.isArray(doc.calendars) && doc.calendars.length).toBe(1);
    expect(config.value.onboardingDone).toBe(true);
    expect(draft.value.step).toBe(1);
  });

  it('does nothing when the tuition is missing', async () => {
    await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    expect(await finishOnboarding()).toBe(false);
    expect(server.puts()).toHaveLength(0);
  });
});

describe('derived values', () => {
  it('reuse the parsed calendar and rebuild pools only when the data changes', async () => {
    await importFiles([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    updateDraft({ tuitionText: '398000' });
    const { pools, billableSessions } = await import('../../src/state/derived');
    const { setConfig } = await import('../../src/state/data');
    const built = buildConfig(draft.value, groups.value, [{ id: 'x', name: 'x' }])!;
    setConfig(built);
    const first = pools.value;
    expect(first.length).toBe(2);
    expect(pools.value).toBe(first); // cached: same array while nothing changed
    expect(billableSessions.value).toHaveLength(58);
    setConfig({ ...built, tuition: { defaultMinor: 20000000, byPool: {} } });
    expect(pools.value).not.toBe(first);
    expect(pools.value[0].tuitionMinor).toBe(20000000);
  });
});

describe('onboarding: two semesters', () => {
  const sessions = expandIcs(fullTermText);
  const g = groupSessions(sessions);
  const sources = [{ id: 'cal-1', name: 'full-term.ics' }];
  // the full-term fixture runs in September-December and (with the old dates) has two pools
  const dates = { yearStart: '08-01', splitDate: '12-25' };

  it('the second semester is optional, and when added it must be a valid amount', () => {
    const base = { ...initialDraft(), tuitionText: '200000', billingPeriod: 'semester' as const };
    expect(tuitionComplete(base)).toBe(true);
    expect(tuitionComplete({ ...base, tuition2Text: '' })).toBe(false);
    expect(tuitionComplete({ ...base, tuition2Text: 'abc' })).toBe(false);
    expect(tuitionComplete({ ...base, tuition2Text: '0' })).toBe(false);
    expect(tuitionComplete({ ...base, tuition2Text: '180,000' })).toBe(true);
    expect(tuition2MinorOf({ tuition2Text: '180000' })).toBe(18000000);
    expect(tuitionComplete({ ...base, tuitionText: '' })).toBe(false);
    // per year there is no second box: whatever it holds is ignored
    expect(tuitionComplete({ ...base, billingPeriod: 'year', tuition2Text: 'abc' })).toBe(true);
  });

  it('"+" and "x" add and remove the second box', () => {
    expect(draft.value.tuition2Text).toBeNull();
    addSecondSemester();
    expect(draft.value.tuition2Text).toBe('');
    updateDraft({ tuition2Text: '180000' });
    addSecondSemester(); // already there: nothing is lost
    expect(draft.value.tuition2Text).toBe('180000');
    removeSecondSemester();
    expect(draft.value.tuition2Text).toBeNull();
  });

  it('the config gives every second-semester pool its own amount; the first amount stays the default', () => {
    const d = { ...initialDraft(), ...dates, tuitionText: '200000', tuition2Text: '180000', billingPeriod: 'semester' as const };
    const config = buildConfig(d, g, sources, sessions);
    expect(config?.tuition).toEqual({ defaultMinor: 20000000, byPool: { '2026-S2': 18000000 } });
    // the same amount twice needs no entry of its own; no second box means the second semester costs the same
    expect(buildConfig({ ...d, tuition2Text: '200000' }, g, sources, sessions)?.tuition).toEqual({ defaultMinor: 20000000, byPool: {} });
    expect(buildConfig({ ...d, tuition2Text: null }, g, sources, sessions)?.tuition).toEqual({ defaultMinor: 20000000, byPool: {} });
    // per year: one amount, no table
    expect(buildConfig({ ...d, billingPeriod: 'year' }, g, sources, sessions)?.tuition).toEqual({ defaultMinor: 20000000 });
    // an incomplete second box blocks the config
    expect(buildConfig({ ...d, tuition2Text: '' }, g, sources, sessions)).toBeNull();
  });

  it('the preview prices each semester with its own amount', () => {
    const d = { ...initialDraft(), ...dates, tuitionText: '200000', tuition2Text: '180000', billingPeriod: 'semester' as const };
    const p = buildPreview(d, sessions, g);
    expect(p.pools.map((x) => x.key)).toEqual(['2026-S1', '2026-S2']);
    const first = buildPreview({ ...d, tuition2Text: null }, sessions, g);
    expect(p.pools[0].rate).toBe(first.pools[0].rate); // semester 1 is unchanged
    expect(p.pools[1].rate).not.toBe(first.pools[1].rate); // semester 2 follows its own tuition
    expect(p.pools[1].average).not.toBe(first.pools[1].average);
  });
});
