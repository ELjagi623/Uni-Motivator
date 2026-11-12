import { describe, expect, it } from 'vitest';
import { expandCalendar, expandIcs, isoSeconds, makeSessionId, mergeSessions, timeToMs } from '../../../src/core/ics/expand';
import { IcsParseError, parseIcs } from '../../../src/core/ics/parse';
import { fixtureSessions, iso, readFixture } from '../helpers';

const starts = (name: string) => fixtureSessions(name).map((s) => iso(s.startMs));
const ends = (name: string) => fixtureSessions(name).map((s) => iso(s.endMs));

function wrap(body: string): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', body, 'END:VCALENDAR'].join('\r\n');
}

describe('expand: weekly series', () => {
  const expectedStarts = ['2026-09-07T01:00:00Z', '2026-09-14T01:00:00Z', '2026-09-21T01:00:00Z', '2026-09-28T01:00:00Z'];
  const expectedEnds = ['2026-09-07T04:00:00Z', '2026-09-14T04:00:00Z', '2026-09-21T04:00:00Z', '2026-09-28T04:00:00Z'];

  it('expands a weekly VTIMEZONE-based series (Mon 09:00-12:00 Hong Kong)', () => {
    expect(starts('weekly.ics')).toEqual(expectedStarts);
    expect(ends('weekly.ics')).toEqual(expectedEnds);
    const first = fixtureSessions('weekly.ics')[0];
    expect(first.title).toBe('MFIN7001 Corporate Finance');
    expect(first.location).toBe('Room 101');
    expect(first.uid).toBe('weekly@fixture');
  });

  it('resolves a TZID without VTIMEZONE through the IANA database', () => {
    expect(starts('weekly-no-vtimezone.ics')).toEqual(expectedStarts);
    expect(ends('weekly-no-vtimezone.ics')).toEqual(expectedEnds);
  });

  it('session ids are UID|original start (UTC, second precision) and identical after re-parsing', () => {
    const ids = fixtureSessions('weekly.ics').map((s) => s.id);
    expect(ids).toEqual(expectedStarts.map((t) => `weekly@fixture|${t}`));
    expect(fixtureSessions('weekly.ics').map((s) => s.id)).toEqual(ids);
    expect(fixtureSessions('weekly-no-vtimezone.ics').map((s) => s.id)).toEqual(ids);
  });
});

describe('expand: EXDATE', () => {
  it('leaves no session on the excluded date', () => {
    expect(starts('exdate.ics')).toEqual([
      '2026-09-07T02:00:00Z',
      '2026-09-14T02:00:00Z',
      '2026-09-28T02:00:00Z', // 2026-09-21 is skipped
      '2026-10-05T02:00:00Z',
      '2026-10-12T02:00:00Z',
    ]);
  });
});

describe('expand: RECURRENCE-ID', () => {
  const sessions = fixtureSessions('recurrence-id.ics');
  const byTitle = (t: string) => sessions.filter((s) => s.title === t);

  it('uses the new time for a moved occurrence but keeps the id of the original start', () => {
    const moved = byTitle('ECON2001 Microeconomics (moved)');
    expect(moved).toHaveLength(1);
    expect(iso(moved[0].startMs)).toBe('2026-09-14T06:00:00Z'); // 14:00 Hong Kong
    expect(iso(moved[0].endMs)).toBe('2026-09-14T07:00:00Z');
    expect(moved[0].id).toBe('moved@fixture|2026-09-14T02:00:00Z'); // original 10:00 Hong Kong
  });

  it('leaves the other occurrences of the series untouched', () => {
    expect(byTitle('ECON2001 Microeconomics').map((s) => iso(s.startMs))).toEqual([
      '2026-09-07T02:00:00Z',
      '2026-09-21T02:00:00Z',
      '2026-09-28T02:00:00Z',
    ]);
  });

  it('matches an exception whose RECURRENCE-ID is written in UTC against a series in local time', () => {
    const moved = byTitle('STAT3001 Statistics (moved)');
    expect(moved).toHaveLength(1);
    expect(iso(moved[0].startMs)).toBe('2026-10-15T10:00:00Z');
    expect(moved[0].id).toBe('moved-utc@fixture|2026-10-15T08:00:00Z');
    expect(byTitle('STAT3001 Statistics')).toHaveLength(2);
  });

  it('keeps a moved occurrence stable when the calendar is parsed again', () => {
    expect(fixtureSessions('recurrence-id.ics').map((s) => s.id)).toEqual(sessions.map((s) => s.id));
  });
});

describe('expand: time zones', () => {
  it('shifts the UTC hour by one across the London daylight-saving change', () => {
    // Clocks go back on 2026-10-25: Monday 19 Oct is BST (UTC+1), 26 Oct and later are GMT (UTC+0).
    expect(starts('london-dst.ics')).toEqual(['2026-10-19T08:00:00Z', '2026-10-26T09:00:00Z', '2026-11-02T09:00:00Z']);
    expect(ends('london-dst.ics')).toEqual(['2026-10-19T09:00:00Z', '2026-10-26T10:00:00Z', '2026-11-02T10:00:00Z']);
  });

  it('treats floating times as the computer time zone (Asia/Hong_Kong under test)', () => {
    expect(starts('floating.ics')).toEqual(['2026-11-12T01:00:00Z']);
    expect(ends('floating.ics')).toEqual(['2026-11-12T02:00:00Z']);
  });

  it('understands UTC (Z) times', () => {
    const s = expandIcs(wrap(['BEGIN:VEVENT', 'UID:z@x', 'DTSTART:20261112T020000Z', 'DTEND:20261112T033000Z', 'SUMMARY:Z', 'END:VEVENT'].join('\r\n')));
    expect(s.map((x) => [iso(x.startMs), iso(x.endMs)])).toEqual([['2026-11-12T02:00:00Z', '2026-11-12T03:30:00Z']]);
  });

  it('maps well-known Windows zone names without VTIMEZONE', () => {
    const s = expandIcs(
      wrap(['BEGIN:VEVENT', 'UID:w@x', 'DTSTART;TZID=China Standard Time:20261112T090000', 'DTEND;TZID=China Standard Time:20261112T100000', 'SUMMARY:W', 'END:VEVENT'].join('\r\n')),
    );
    expect(iso(s[0].startMs)).toBe('2026-11-12T01:00:00Z');
  });

  it('falls back to the local zone for a TZID nobody knows', () => {
    const s = expandIcs(
      wrap(['BEGIN:VEVENT', 'UID:u@x', 'DTSTART;TZID=Nowhere/Land:20261112T090000', 'DTEND;TZID=Nowhere/Land:20261112T100000', 'SUMMARY:U', 'END:VEVENT'].join('\r\n')),
    );
    expect(iso(s[0].startMs)).toBe('2026-11-12T01:00:00Z');
  });

  it('timeToMs handles a London wall-clock time in summer and winter', async () => {
    const ICAL = (await import('ical.js')).default;
    const summer = ICAL.Time.fromData({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 });
    const winter = ICAL.Time.fromData({ year: 2026, month: 12, day: 1, hour: 9, minute: 0, second: 0 });
    expect(iso(timeToMs(summer, 'Europe/London'))).toBe('2026-07-01T08:00:00Z');
    expect(iso(timeToMs(winter, 'Europe/London'))).toBe('2026-12-01T09:00:00Z');
  });
});

describe('expand: filtering', () => {
  it('drops all-day events (single and recurring) and keeps timed ones', () => {
    const s = fixtureSessions('allday.ics');
    expect(s.map((x) => x.title)).toEqual(['COMP3230 Lecture']);
  });

  it('drops CANCELLED events and CANCELLED occurrences of a series', () => {
    expect(starts('cancelled.ics')).toEqual(['2026-11-03T01:00:00Z', '2026-11-17T01:00:00Z']);
  });

  it('skips events without a positive duration', () => {
    const s = expandIcs(wrap(['BEGIN:VEVENT', 'UID:d@x', 'DTSTART:20261112T020000Z', 'SUMMARY:No end', 'END:VEVENT'].join('\r\n')));
    expect(s).toEqual([]);
  });

  it('understands DURATION instead of DTEND', () => {
    const s = expandIcs(wrap(['BEGIN:VEVENT', 'UID:p@x', 'DTSTART:20261112T020000Z', 'DURATION:PT90M', 'SUMMARY:Dur', 'END:VEVENT'].join('\r\n')));
    expect(s[0].endMs - s[0].startMs).toBe(90 * 60_000);
  });
});

describe('expand: other shapes', () => {
  it('keeps overlapping classes as two sessions', () => {
    const s = fixtureSessions('overlap.ics');
    expect(s.map((x) => [iso(x.startMs), iso(x.endMs)])).toEqual([
      ['2026-11-12T02:00:00Z', '2026-11-12T04:00:00Z'],
      ['2026-11-12T03:00:00Z', '2026-11-12T05:00:00Z'],
    ]);
  });

  it('keeps the full duration of a class that crosses midnight', () => {
    const [s] = fixtureSessions('midnight.ics');
    expect(iso(s.startMs)).toBe('2026-11-12T15:00:00Z'); // 23:00 Hong Kong
    expect(s.endMs - s.startMs).toBe(2 * 3_600_000);
  });

  it('turns an orphan exception (no master in the file) into a stand-alone session with the RECURRENCE-ID as original start', () => {
    const s = expandIcs(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:orphan@x',
          'RECURRENCE-ID:20261112T020000Z',
          'DTSTART:20261112T060000Z',
          'DTEND:20261112T070000Z',
          'SUMMARY:Orphan',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    expect(s).toHaveLength(1);
    expect(s[0].id).toBe('orphan@x|2026-11-12T02:00:00Z');
    expect(iso(s[0].startMs)).toBe('2026-11-12T06:00:00Z');
  });

  it('de-duplicates identical ids and sorts by start', () => {
    const one = ['BEGIN:VEVENT', 'UID:dup@x', 'DTSTART:20261112T020000Z', 'DTEND:20261112T030000Z', 'SUMMARY:A', 'END:VEVENT'].join('\r\n');
    const early = ['BEGIN:VEVENT', 'UID:early@x', 'DTSTART:20261101T020000Z', 'DTEND:20261101T030000Z', 'SUMMARY:B', 'END:VEVENT'].join('\r\n');
    const s = expandIcs(wrap([one, one, early].join('\r\n')));
    expect(s.map((x) => x.uid)).toEqual(['early@x', 'dup@x']);
  });

  it('merges sessions from several calendar files without duplicates', () => {
    const a = fixtureSessions('weekly.ics');
    const b = fixtureSessions('weekly.ics').concat(fixtureSessions('exdate.ics'));
    const merged = mergeSessions([a, b]);
    expect(merged).toHaveLength(9);
    expect(merged.map((s) => s.startMs)).toEqual([...merged.map((s) => s.startMs)].sort((x, y) => x - y));
  });

  it('expands an endless RRULE only up to the horizon / safety limits', () => {
    const text = wrap(
      ['BEGIN:VEVENT', 'UID:inf@x', 'DTSTART:20260907T020000Z', 'DTEND:20260907T030000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Endless', 'END:VEVENT'].join('\r\n'),
    );
    const byDefault = expandIcs(text);
    expect(byDefault.length).toBeGreaterThan(100);
    expect(byDefault.length).toBeLessThan(120); // 760 days of weekly occurrences
    const horizon = Date.parse('2026-10-01T00:00:00Z');
    expect(expandIcs(text, { horizonMs: horizon })).toHaveLength(4);
    expect(expandIcs(text, { maxPerSeries: 3 })).toHaveLength(3);
  });

  it('is independent of the order in which calendars were parsed (global timezone registry is refilled)', () => {
    const london = parseIcs(readFixture('london-dst.ics'));
    const weekly = parseIcs(readFixture('weekly.ics'));
    const a = expandCalendar(weekly).map((s) => s.id);
    const b = expandCalendar(london).map((s) => iso(s.startMs));
    const a2 = expandCalendar(weekly).map((s) => s.id);
    expect(a2).toEqual(a);
    expect(b).toEqual(['2026-10-19T08:00:00Z', '2026-10-26T09:00:00Z', '2026-11-02T09:00:00Z']);
  });
});

describe('expand: id helpers and errors', () => {
  it('formats ids with second-precision UTC', () => {
    expect(isoSeconds(Date.UTC(2026, 10, 12, 2, 0, 0, 999))).toBe('2026-11-12T02:00:00Z');
    expect(makeSessionId('abc@school', Date.UTC(2026, 10, 12, 2, 0, 0))).toBe('abc@school|2026-11-12T02:00:00Z');
  });

  it('throws a content-free IcsParseError for broken input', () => {
    let error: unknown;
    try {
      parseIcs('BEGIN:VCALENDAR\nSECRET-COURSE-NAME');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(IcsParseError);
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('returns no sessions for a calendar without events', () => {
    expect(expandIcs(wrap(''))).toEqual([]);
  });

  it('handles several VCALENDARs in one text', () => {
    const one = wrap(['BEGIN:VEVENT', 'UID:m1@x', 'DTSTART:20261112T020000Z', 'DTEND:20261112T030000Z', 'SUMMARY:A', 'END:VEVENT'].join('\r\n'));
    const two = wrap(['BEGIN:VEVENT', 'UID:m2@x', 'DTSTART:20261113T020000Z', 'DTEND:20261113T030000Z', 'SUMMARY:B', 'END:VEVENT'].join('\r\n'));
    expect(expandIcs(`${one}\r\n${two}`).map((s) => s.uid)).toEqual(['m1@x', 'm2@x']);
  });
});

describe('expand: the full-term fixture', () => {
  it('has 58 sessions: 29 per semester, 87 hours per semester', () => {
    const s = fixtureSessions('full-term.ics');
    expect(s).toHaveLength(58);
    const hours = s.reduce((a, x) => a + (x.endMs - x.startMs) / 3_600_000, 0);
    expect(hours).toBe(174);
    // Thursday 2026-11-12 10:00-13:00 Hong Kong exists, Thursday 2026-10-01 is excluded.
    const ids = new Set(s.map((x) => x.id));
    expect(ids.has('ft-thu-s1@fixture|2026-11-12T02:00:00Z')).toBe(true);
    expect([...ids].some((id) => id.includes('2026-10-01'))).toBe(false);
    expect(iso(s[0].startMs)).toBe('2026-09-03T02:00:00Z');
    expect(iso(s.at(-1)!.endMs)).toBe('2027-04-26T04:00:00Z');
  });
});
