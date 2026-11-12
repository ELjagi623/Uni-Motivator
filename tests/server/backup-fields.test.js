// POST /api/import checks the fields of a backup (types and enumerations), not only its outline (B4 fix).
// Everything a backup refused here must leave the data and data/backups/ exactly as they were.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withServer, putDoc } from './helpers.js';

let s;
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const KEY = 'uid-3@example|2026-11-12T06:00:00Z';
const SECRET = 'zz-secret-value';

const stripRev = (doc) => {
  const { rev: _rev, ...rest } = doc;
  return rest;
};
const snapshot = async () => {
  const d = (await s.request({ path: '/api/data' })).json;
  return { config: stripRev(d.config), marks: stripRev(d.marks), slacks: stripRev(d.slacks), calendars: d.calendars };
};
const backupsOf = () => {
  const dir = path.join(s.dataDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('_before-import.json')).sort() : [];
};
const postImport = (body, extra = {}) => s.request({ method: 'POST', path: '/api/import', write: true, json: body, ...extra });
const getExport = async () => (await s.request({ path: '/api/export' })).json;

/**
 * Everything the app writes after P4b / P4c: credits, a second currency with a manual rate, several academic years,
 * manual classes, late / early marks, language, copy intensity, theme, reminders.
 */
const richDocs = () => ({
  config: {
    schemaVersion: 1,
    onboardingDone: true,
    school: 'Some University (HKU) 香港',
    region: 'northern',
    currency: 'HKD',
    secondaryCurrency: 'CNY',
    rates: { CNY: 0.14, USD: 1 },
    academic: { yearStart: '08-01', splitDate: '12-25', billingPeriod: 'semester' },
    billingMode: 'credit',
    tuition: { defaultMinor: 39800000, byPool: { '2026-S1': 41000000, '2026-S2': null, '2027-S1': 0 } },
    courses: [
      { id: 'c-a', code: 'MFIN7001', name: 'Corporate Finance', credits: 4, color: '#3b6ea8', match: { codes: ['MFIN7001'], titles: [] } },
      { id: 'c-b', code: null, name: '研讨课', credits: null, color: '#c8763a', match: { codes: [], titles: ['研讨课'] } },
      { id: 'c-m-seminar', code: null, name: 'Seminar', credits: 1.5, color: '#4f9d69', match: { codes: [], titles: ['seminar'] }, manual: true },
    ],
    calendars: [{ id: 'cal-a', name: 'full-term.ics' }, { id: 'cal-b', name: 'next-year.ics' }],
    reminders: { enabled: true, leadMinutes: 10 },
    language: 'zh-TW',
    intensity: 'extreme',
    theme: 'dark',
  },
  marks: {
    schemaVersion: 1,
    marks: {
      'uid-1@example|2026-11-10T06:00:00Z': { status: 'skipped' },
      'uid-2@example|2026-11-11T06:00:00Z': { status: 'cancelled' },
      [KEY]: { lateMin: 10, earlyMin: 20 },
      'manual:c-m-seminar|2026-11-10T06:00:00Z': { lateMin: 0, earlyMin: 5 },
    },
    manual: {
      weekly: [{ id: 'w-1', courseId: 'c-m-seminar', title: 'Seminar', weekday: 2, start: '14:00', end: '17:00', fromDate: '2026-09-08', toDate: '2026-12-01', skipDates: ['2026-10-06'], timeZone: 'Asia/Hong_Kong' }],
      singles: [{ id: 's-1', courseId: 'c-a', title: 'Corporate Finance', date: '2026-11-20', start: '19:00', end: '21:00' }],
    },
  },
  slacks: {
    schemaVersion: 1,
    records: [
      { id: 'r1', sessionId: 'uid-1@example|2026-11-10T06:00:00Z', startMs: 1788000000000, endMs: 1788000300000 },
      { id: 'r2', sessionId: KEY, startMs: 1788100000000 },
    ],
  },
});

const putRich = async (docs) => {
  const cur = (await s.request({ path: '/api/data' })).json;
  for (const name of ['config', 'marks', 'slacks']) {
    const r = await putDoc(s.port, name, cur[name].rev, docs[name]);
    assert.equal(r.status, 200, `${name}: ${r.text}`);
  }
};

before(async () => {
  s = await withServer();
  const c = await s.request({ method: 'POST', path: '/api/calendars', write: true, headers: { 'Content-Type': 'text/calendar' }, body: ICS });
  assert.equal(c.status, 201);
  await putRich(richDocs());
});
after(async () => {
  await s.cleanup();
});

describe('backup: field-level checks', () => {
  it('a file this program exported with real-shaped data (credits, second currency, several years, manual classes, late / early, language, intensity) imports again and the data is identical', async () => {
    const before = await snapshot();
    assert.equal(before.config.language, 'zh-TW');
    const exported = await getExport();
    // change something, then bring the exported file back
    const cur = (await s.request({ path: '/api/data' })).json.config;
    await putDoc(s.port, 'config', cur.rev, { schemaVersion: 1, tuition: { defaultMinor: 1 } });
    const r = await postImport(exported);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(await snapshot(), before);
    // and again from a copy that went through a file (JSON text) on the way
    assert.equal((await postImport(JSON.parse(JSON.stringify(exported)))).status, 200);
    assert.deepEqual(await snapshot(), before);
  });

  it('refuses wrongly typed fields with 400 naming the field (not echoing the value), changes nothing and leaves no backup', async () => {
    const good = await getExport();
    const before = await snapshot();
    const backups = backupsOf().length;
    const withDoc = (name, patch) => ({ ...good, [name]: { ...good[name], ...patch } });
    const cfg = (patch) => withDoc('config', patch);
    const tuition = (patch) => cfg({ tuition: { ...good.config.tuition, ...patch } });
    const course = (patch) => cfg({ courses: [{ ...good.config.courses[0], ...patch }, ...good.config.courses.slice(1)] });
    const mark = (patch) => withDoc('marks', { marks: { ...good.marks.marks, [KEY]: patch } });
    const weekly = (patch) => withDoc('marks', { manual: { ...good.marks.manual, weekly: [{ ...good.marks.manual.weekly[0], ...patch }] } });
    const single = (patch) => withDoc('marks', { manual: { ...good.marks.manual, singles: [{ ...good.marks.manual.singles[0], ...patch }] } });
    const slack = (patch) => withDoc('slacks', { records: [{ ...good.slacks.records[0], ...patch }, good.slacks.records[1]] });
    const cases = [
      ['defaultMinor is a string', tuition({ defaultMinor: 'abc' }), 'config.tuition.defaultMinor'],
      ['defaultMinor is a fraction', tuition({ defaultMinor: 100.5 }), 'config.tuition.defaultMinor'],
      ['defaultMinor is negative', tuition({ defaultMinor: -1 }), 'config.tuition.defaultMinor'],
      ['defaultMinor is huge', tuition({ defaultMinor: 1e30 }), 'config.tuition.defaultMinor'],
      ['defaultMinor is a boolean', tuition({ defaultMinor: true }), 'config.tuition.defaultMinor'],
      ['tuition is a list', cfg({ tuition: [] }), 'config.tuition'],
      ['byPool is a list', tuition({ byPool: [] }), 'config.tuition.byPool'],
      ['a pool amount is text', tuition({ byPool: { '2026-S1': SECRET } }), 'config.tuition.byPool'],
      ['a pool amount is a fraction', tuition({ byPool: { '2026-S1': 1.5 } }), 'config.tuition.byPool'],
      ['currency not in the list', cfg({ currency: 'XXX' }), 'config.currency'],
      ['currency is a number', cfg({ currency: 5 }), 'config.currency'],
      ['secondaryCurrency not in the list', cfg({ secondaryCurrency: 'BTC' }), 'config.secondaryCurrency'],
      ['billingMode not in the list', cfg({ billingMode: 'hourly' }), 'config.billingMode'],
      ['billingPeriod not in the list', cfg({ academic: { ...good.config.academic, billingPeriod: 'month' } }), 'config.academic.billingPeriod'],
      ['yearStart is not a date', cfg({ academic: { ...good.config.academic, yearStart: '13-45' } }), 'config.academic.yearStart'],
      ['splitDate is missing', cfg({ academic: { yearStart: '08-01', billingPeriod: 'year' } }), 'config.academic.splitDate'],
      ['academic is text', cfg({ academic: 'x' }), 'config.academic'],
      ['region not in the list', cfg({ region: 'east' }), 'config.region'],
      ['theme not in the list', cfg({ theme: 'blue' }), 'config.theme'],
      ['language not in the list', cfg({ language: 'fr' }), 'config.language'],
      ['intensity not in the list', cfg({ intensity: 'brutal' }), 'config.intensity'],
      ['onboardingDone is text', cfg({ onboardingDone: 'yes' }), 'config.onboardingDone'],
      ['school is a number', cfg({ school: 7 }), 'config.school'],
      ['courses is an object', cfg({ courses: {} }), 'config.courses'],
      ['a course is text', cfg({ courses: ['x'] }), 'config.courses[0]'],
      ['course credits are text', course({ credits: 'four' }), 'config.courses[0].credits'],
      ['course credits are negative', course({ credits: -2 }), 'config.courses[0].credits'],
      ['course without id', course({ id: undefined }), 'config.courses[0].id'],
      ['course match is wrong', course({ match: { codes: 'x', titles: [] } }), 'config.courses[0].match'],
      ['calendars is text', cfg({ calendars: 'x' }), 'config.calendars'],
      ['calendar source without name', cfg({ calendars: [{ id: 'cal-a' }] }), 'config.calendars[0].name'],
      ['reminders.enabled is text', cfg({ reminders: { enabled: 'on', leadMinutes: 5 } }), 'config.reminders.enabled'],
      ['reminders.leadMinutes is negative', cfg({ reminders: { enabled: true, leadMinutes: -5 } }), 'config.reminders.leadMinutes'],
      ['a rate is text', cfg({ rates: { CNY: SECRET } }), 'config.rates'],
      ['a rate is zero', cfg({ rates: { CNY: 0 } }), 'config.rates'],
      ['marks is a list', withDoc('marks', { marks: [] }), 'marks.marks'],
      ['a mark is text', mark(SECRET), 'marks.marks'],
      ['a mark has an unknown status', mark({ status: 'sleeping' }), 'status'],
      ['lateMin is text', mark({ lateMin: '10' }), 'lateMin'],
      ['earlyMin is negative', mark({ earlyMin: -1 }), 'earlyMin'],
      ['manual is text', withDoc('marks', { manual: 'x' }), 'marks.manual'],
      ['weekly is an object', withDoc('marks', { manual: { weekly: {} } }), 'marks.manual.weekly'],
      ['weekday out of range', weekly({ weekday: 9 }), 'marks.manual.weekly[0].weekday'],
      ['weekly skipDates is text', weekly({ skipDates: SECRET }), 'marks.manual.weekly[0].skipDates'],
      ['weekly start is a number', weekly({ start: 1400 }), 'marks.manual.weekly[0].start'],
      ['single without courseId', single({ courseId: undefined }), 'marks.manual.singles[0].courseId'],
      ['single date is a number', single({ date: 20261120 }), 'marks.manual.singles[0].date'],
      ['records is an object', withDoc('slacks', { records: {} }), 'slacks.records'],
      ['a record is text', withDoc('slacks', { records: [SECRET] }), 'slacks.records[0]'],
      ['startMs is text', slack({ startMs: '1788000000000' }), 'slacks.records[0].startMs'],
      ['startMs is missing', slack({ startMs: undefined }), 'slacks.records[0].startMs'],
      ['startMs is null (what NaN becomes in JSON)', slack({ startMs: null }), 'slacks.records[0].startMs'],
      ['endMs is text', slack({ endMs: 'later' }), 'slacks.records[0].endMs'],
      ['record without sessionId', slack({ sessionId: undefined }), 'slacks.records[0].sessionId'],
      ['calendar text is a number', { ...good, calendars: [{ id: 'cal-a', text: 42 }] }, 'calendar'],
    ];
    for (const [name, body, field] of cases) {
      const r = await postImport(body);
      assert.equal(r.status, 400, `${name}: ${r.status} ${r.text.slice(0, 200)}`);
      assert.equal(r.json.error, 'bad_backup', name);
      assert.ok(r.json.message.includes(field), `${name}: message "${r.json.message}" does not name ${field}`);
      assert.ok(r.json.message.length < 200, `${name}: the message is long (does it echo the data?)`);
      assert.equal(r.text.includes(SECRET), false, `${name}: the response echoes the data`);
    }
    // a number JSON text can carry but no double can (1e999 parses to Infinity)
    const infinity = JSON.stringify(tuition({ defaultMinor: 0 })).replace('"defaultMinor":0', '"defaultMinor":1e999');
    const r = await s.request({ method: 'POST', path: '/api/import', write: true, headers: { 'Content-Type': 'application/json' }, body: infinity });
    assert.equal(r.status, 400);
    assert.deepEqual(await snapshot(), before, 'a refused import changed the data');
    assert.equal(backupsOf().length, backups, 'a refused import left a backup behind');
  });

  it('tolerates fields it does not know (a later version may add some) and keeps them; bare documents are fine too', async () => {
    const good = await getExport();
    const future = {
      ...good,
      futureTopLevel: { a: 1 },
      config: { ...good.config, newSetting: { x: [1, 2] }, tuition: { ...good.config.tuition, note: 'later' }, courses: good.config.courses.map((c) => ({ ...c, tags: ['x'] })) },
      marks: { ...good.marks, other: [1] },
      slacks: { ...good.slacks, records: good.slacks.records.map((r) => ({ ...r, note: 'later' })) },
    };
    const r = await postImport(future);
    assert.equal(r.status, 200, r.text);
    const data = (await s.request({ path: '/api/data' })).json;
    assert.deepEqual(data.config.newSetting, { x: [1, 2] });
    assert.equal(data.config.tuition.note, 'later');
    assert.deepEqual(data.config.courses[0].tags, ['x']);
    assert.deepEqual(data.marks.other, [1]);
    assert.equal(data.slacks.records[0].note, 'later');

    // a data folder that has never been used exports bare documents; they come back as they are
    const bare = { ...good, config: { schemaVersion: 1 }, marks: { schemaVersion: 1 }, slacks: { schemaVersion: 1 }, calendars: [] };
    assert.equal((await postImport(bare)).status, 200);
    assert.deepEqual(await snapshot(), { config: { schemaVersion: 1 }, marks: { schemaVersion: 1 }, slacks: { schemaVersion: 1 }, calendars: [] });
  });
});
