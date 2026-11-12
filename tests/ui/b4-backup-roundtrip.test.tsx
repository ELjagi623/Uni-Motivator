// @vitest-environment happy-dom
// B4 fix: the backup import checks the fields of a file (types, enumerations). The documents the REAL front-end code
// writes - after onboarding, two academic years, credits, a second currency with a manual rate, manual classes,
// late / early minutes, skipped / cancelled marks, slacking records, language, copy intensity, theme, reminders -
// must all pass that check, otherwise this program's own exports could not be imported again.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error the server is plain JavaScript (no type declarations)
import { createStore } from '../../server/store.js';
import { DEFAULT_LOCALE, setLocale } from '../../src/i18n';
import { editRateText, setSecondaryCurrency } from '../../src/state/currency';
import { setIntensity } from '../../src/state/intensity';
import { chooseLanguage } from '../../src/state/language';
import { setLateEarly, setMark } from '../../src/state/marks';
import { setReminderConfig } from '../../src/state/reminders';
import { endSlack, startSlack } from '../../src/state/slack';
import { setTheme } from '../../src/state/theme';
import { boot, flushSaves, teardown } from './harness';
import { CLASS_ID, NEXT_CLASS_ID, NOWS, fullTermText, nextYearText, twoYearConfig } from '../state/fixture-app';

const MON = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';

beforeEach(() => {
  localStorage.clear();
  setLocale(DEFAULT_LOCALE);
});
afterEach(() => {
  teardown();
  setLocale(DEFAULT_LOCALE);
  localStorage.clear();
});

describe('backups written from real app data can be imported again', () => {
  it('every setting and every kind of record the app writes passes the import check (two years, credits, second currency, manual classes, late / early, slacking, language, intensity, theme, reminders)', async () => {
    const h = await boot({ path: '/sessions', nowMs: NOWS.inClass, configOverride: { ...twoYearConfig(), billingMode: 'credit' }, texts: [fullTermText, nextYearText] });
    const set = async (fn: () => void) => {
      await act(async () => fn());
      await h.settle();
    };
    await set(() => chooseLanguage('zh-TW'));
    await set(() => setIntensity('extreme'));
    await set(() => setTheme('dark'));
    await set(() => setSecondaryCurrency('CNY'));
    await set(() => void editRateText('0.14'));
    await set(() => setReminderConfig({ enabled: true, leadMinutes: 10 }));
    await set(() => void setMark(CLASS_ID, 'skipped'));
    await set(() => void setMark(NEXT_CLASS_ID, 'cancelled'));
    await set(() => void setLateEarly(MON, 'late', '10'));
    await set(() => void setLateEarly(MON, 'early', '20'));
    // a finished and a running slacking record
    await startSlack(MON, NOWS.inClass - 3_600_000);
    await h.settle();
    await set(() => {
      const record = h.server.docs.slacks.records as Array<{ id: string }>;
      endSlack(record[0].id, NOWS.inClass - 3_000_000);
    });
    // manual classes through the real form: a weekly course and a one-off make-up class
    await h.click('#manual-open');
    await h.type('#manual-name', 'Seminar');
    await h.type('#manual-credits', '1.5');
    await act(async () => h.$<HTMLInputElement>('input[name="manual-weekday"][value="2"]')!.click());
    await h.type('#manual-start', '14:00');
    await h.type('#manual-end', '17:00');
    await h.type('#manual-from', '2026-09-08');
    await h.type('#manual-to', '2026-12-01');
    await h.type('#manual-skip', '2026-10-06');
    await h.click('#manual-submit-weekly');
    await h.click('#manual-dialog-ok');
    if (!h.$('input[name="manual-tab"]')) await h.click('#manual-open');
    await act(async () => h.$<HTMLInputElement>('input[name="manual-tab"][value="single"]')!.click());
    await h.type('#manual-date', '2026-11-14');
    await h.type('#manual-start', '10:00');
    await h.type('#manual-end', '12:30');
    await h.click('#manual-submit-single');
    await h.click('#manual-dialog-ok');
    await flushSaves();

    const docs = h.server.docs;
    // the data really contains what this test is about
    expect(docs.config).toMatchObject({ billingMode: 'credit', language: 'zh-TW', intensity: 'extreme', theme: 'dark', secondaryCurrency: 'CNY', reminders: { enabled: true, leadMinutes: 10 } });
    expect(docs.config.rates).toEqual({ CNY: expect.any(Number) });
    expect((docs.config.courses as Array<{ manual?: boolean }>).some((c) => c.manual)).toBe(true);
    expect(docs.marks.marks).toMatchObject({ [CLASS_ID]: { status: 'skipped' }, [NEXT_CLASS_ID]: { status: 'cancelled' }, [MON]: { lateMin: 10, earlyMin: 20 } });
    const manual = docs.marks.manual as { weekly: unknown[]; singles: unknown[] };
    expect(manual.weekly).toHaveLength(1);
    expect(manual.singles).toHaveLength(1);
    expect((docs.slacks.records as unknown[]).length).toBeGreaterThanOrEqual(1);

    // exactly what the export writes: the three documents without rev, plus the calendars
    const strip = (doc: Record<string, unknown>) => {
      const { rev: _rev, ...rest } = doc;
      return rest;
    };
    const backup = {
      app: 'tuition-ticker',
      kind: 'backup',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      config: strip(docs.config),
      marks: strip(docs.marks),
      slacks: strip(docs.slacks),
      calendars: [...h.server.calendars].map(([id, text]) => ({ id, text })),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-b4-'));
    try {
      const store = createStore({ dataDir: dir });
      const checked = store.validateBackup(JSON.parse(JSON.stringify(backup)));
      expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
