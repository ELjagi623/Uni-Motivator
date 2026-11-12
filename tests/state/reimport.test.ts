import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addCalendars, importFiles, replaceCalendar, replaceReport, resetCalendarState, syncCalendarSources } from '../../src/state/calendars';
import { calendars, config, flushSaves, loadAll, marks, resetDataState } from '../../src/state/data';
import { allSessions } from '../../src/state/derived';
import { marksOf } from '../../src/state/dashboard';
import { setMark } from '../../src/state/marks';
import { installFakeServer, type FakeServer } from './fake-server';

let server: FakeServer;

const CAL_HEAD = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN'];
const ev = (lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const ics = (...events: string[][]) => [...CAL_HEAD, ...events.flat(), 'END:VCALENDAR', ''].join('\r\n');
const item = (name: string, text: string) => ({ name, data: new Uint8Array(Buffer.from(text, 'utf8')) });

/** Six Thursdays 10:00-13:00 UTC, from 2026-11-12. */
const weekly = (count = 6) => ev(['UID:wk@t', 'DTSTART:20261112T100000Z', 'DTEND:20261112T130000Z', `RRULE:FREQ=WEEKLY;COUNT=${count}`, 'SUMMARY:AAAA1000 Algebra']);
const idOf = (n: number) => `wk@t|${new Date(Date.UTC(2026, 10, 12 + 7 * n, 10, 0, 0)).toISOString().replace('.000Z', 'Z')}`;

const original = ics(weekly());
/** The same UID again, with the third class (n = 2) moved to a different day and hour by the school. */
const moved = ics(weekly(), ev(['UID:wk@t', 'RECURRENCE-ID:' + idOf(2).split('|')[1].replace(/[-:]/g, ''), 'DTSTART:20261201T080000Z', 'DTEND:20261201T110000Z', 'SUMMARY:AAAA1000 Algebra']));

beforeEach(async () => {
  resetDataState();
  resetCalendarState();
  server = installFakeServer({ config: { schemaVersion: 1, onboardingDone: true, calendars: [{ id: 'cal-orig', name: 'term.ics' }] } }, [{ id: 'cal-orig', text: original }]);
  await loadAll();
});

afterEach(() => {
  server.restore();
});

const sessionOf = (id: string) => allSessions.value.find((s) => s.id === id);

describe('re-importing a calendar keeps the marks', () => {
  it('marks stay attached by session id; a class the school moved keeps its mark under the original-start id', async () => {
    setMark(idOf(1), 'skipped');
    setMark(idOf(2), 'cancelled');
    await flushSaves();
    const startBefore = sessionOf(idOf(2))!.startMs;
    expect(allSessions.value).toHaveLength(6);

    const report = await replaceCalendar('cal-orig', [item('term-new.ics', moved)]);
    expect(report.status).toBe('replaced');
    expect(report.sessionsBefore).toBe(6);
    expect(report.sessionsAfter).toBe(6);
    expect(report.marksKept).toBe(2);
    expect(report.marksOrphaned).toBe(0);

    // the moved class has a different time but the same id (original start), so its mark is still on it
    const after = sessionOf(idOf(2))!;
    expect(after.startMs).not.toBe(startBefore);
    expect(after.startMs).toBe(Date.UTC(2026, 11, 1, 8, 0, 0));
    expect(marksOf(marks.value)[idOf(2)]).toEqual({ status: 'cancelled' });
    expect(marksOf(marks.value)[idOf(1)]).toEqual({ status: 'skipped' });
    expect(sessionOf(`wk@t|${new Date(after.startMs).toISOString().replace('.000Z', 'Z')}`)).toBeUndefined(); // no new id for the new time
  });

  it('stores the new file, deletes the old one and updates config.calendars', async () => {
    await replaceCalendar('cal-orig', [item('term-new.ics', moved)]);
    await flushSaves();
    const methods = server.calls.map((c) => `${c.method} ${c.url}`);
    expect(methods).toContain('POST /api/calendars');
    expect(methods).toContain('DELETE /api/calendars/cal-orig');
    expect(server.calendars.has('cal-orig')).toBe(false);
    expect(server.calendars.size).toBe(1);
    expect(calendars.value).toHaveLength(1);
    expect(calendars.value[0].id).not.toBe('cal-orig');
    expect(config.value.calendars).toEqual([{ id: calendars.value[0].id, name: 'term-new.ics' }]);
    expect(server.puts('config')).toHaveLength(1);
  });

  it('a mark whose class is gone from the new timetable is kept but reported as orphaned; it is back when the class is', async () => {
    setMark(idOf(5), 'skipped');
    const shorter = ics(weekly(4));
    const report = await replaceCalendar('cal-orig', [item('short.ics', shorter)]);
    expect(report.sessionsAfter).toBe(4);
    expect(report.marksKept).toBe(0);
    expect(report.marksOrphaned).toBe(1);
    expect(marksOf(marks.value)[idOf(5)]).toEqual({ status: 'skipped' });
    const again = await replaceCalendar(calendars.value[0].id, [item('full.ics', original)]);
    expect(again.marksKept).toBe(1);
    expect(again.marksOrphaned).toBe(0);
  });

  it('an identical file changes nothing (no delete, no config write)', async () => {
    const report = await replaceCalendar('cal-orig', [item('term.ics', original)]);
    expect(report.status).toBe('unchanged');
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calendars.value.map((c) => c.id)).toEqual(['cal-orig']);
    expect(replaceReport.value?.status).toBe('unchanged');
  });

  it('a file that is not a calendar leaves everything as it was', async () => {
    const report = await replaceCalendar('cal-orig', [item('notes.txt', 'hello'), item('bad.ics', 'not a calendar')]);
    expect(report.status).toBe('failed');
    expect(report.failures.map((f) => f.reason)).toEqual(['unsupported', 'not-calendar']);
    expect(server.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(calendars.value.map((c) => c.id)).toEqual(['cal-orig']);
  });

  it('when the upload fails the old calendar stays', async () => {
    server.failNext(500);
    const report = await replaceCalendar('cal-orig', [item('term-new.ics', moved)]);
    expect(report.status).toBe('failed');
    expect(report.failures[0].reason).toBe('upload');
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calendars.value.map((c) => c.id)).toEqual(['cal-orig']);
  });
});

describe('adding calendars from the settings page', () => {
  it('adds a second calendar and records it in config.calendars; duplicates are noticed', async () => {
    const other = ics(ev(['UID:other@t', 'DTSTART:20261113T100000Z', 'DTEND:20261113T120000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:BBBB2000 Other']));
    const report = await addCalendars([item('other.ics', other)]);
    expect(report.added).toBe(1);
    expect(calendars.value).toHaveLength(2);
    expect(config.value.calendars?.map((c) => c.name)).toEqual(['term.ics', 'other.ics']);
    const dup = await importFiles([item('other-again.ics', other)]);
    expect(dup.duplicates).toEqual(['other-again.ics']);
    syncCalendarSources(); // idempotent
    expect(config.value.calendars).toHaveLength(2);
    expect(allSessions.value).toHaveLength(9);
  });
});
