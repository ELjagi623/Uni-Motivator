import { describe, expect, it } from 'vitest';
import { getStatus } from '../../src/core/status';
import type { Session } from '../../src/core/types';
import { at, fixtureSessions } from './helpers';

const term = fixtureSessions('full-term.ics');
const THU = 'ft-thu-s1@fixture|2026-11-12T02:00:00Z'; // Thu 2026-11-12 10:00-13:00 Hong Kong

const mk = (id: string, start: string, end: string): Session => ({ id, uid: id, title: id, location: '', startMs: at(start), endMs: at(end) });

describe('getStatus on the full-term calendar: the six states', () => {
  it('before-term: weeks before the first class', () => {
    const s = getStatus(at('2026-08-20T12:00:00+08:00'), term);
    expect(s.kind).toBe('before-term');
    expect(s.current).toBeUndefined();
    expect(s.prev).toBeUndefined();
    expect(s.next?.startMs).toBe(at('2026-09-03T10:00:00+08:00'));
    expect(s.today).toEqual([]);
  });

  it('in-class: 10:30 on a Thursday with class 10:00-13:00', () => {
    const s = getStatus(at('2026-11-12T10:30:00+08:00'), term);
    expect(s.kind).toBe('in-class');
    expect(s.current?.id).toBe(THU);
    expect(s.alsoActive).toEqual([]);
    expect(s.next?.startMs).toBe(at('2026-11-16T09:00:00+08:00')); // the next Monday
    expect(s.prev?.startMs).toBe(at('2026-11-09T09:00:00+08:00'));
    expect(s.today.map((x) => x.id)).toEqual([THU]);
  });

  it('done-today: after the last class of a class day', () => {
    const s = getStatus(at('2026-11-12T14:00:00+08:00'), term);
    expect(s.kind).toBe('done-today');
    expect(s.prev?.id).toBe(THU);
    expect(s.next?.startMs).toBe(at('2026-11-16T09:00:00+08:00'));
  });

  it('no-class-today: a weekday without class in the middle of the term', () => {
    const s = getStatus(at('2026-11-13T10:00:00+08:00'), term);
    expect(s.kind).toBe('no-class-today');
    expect(s.today).toEqual([]);
    expect(s.prev?.id).toBe(THU);
    expect(s.next?.startMs).toBe(at('2026-11-16T09:00:00+08:00'));
  });

  it('after-term: after the last class of the calendar', () => {
    const s = getStatus(at('2027-05-01T12:00:00+08:00'), term);
    expect(s.kind).toBe('after-term');
    expect(s.next).toBeUndefined();
    expect(s.prev?.startMs).toBe(at('2027-04-26T09:00:00+08:00'));
  });

  it('break: between two classes on the same day', () => {
    const day = [mk('a', '2026-11-12T09:00:00+08:00', '2026-11-12T10:00:00+08:00'), mk('b', '2026-11-12T14:00:00+08:00', '2026-11-12T15:00:00+08:00')];
    const s = getStatus(at('2026-11-12T11:00:00+08:00'), day);
    expect(s.kind).toBe('break');
    expect(s.prev?.id).toBe('a');
    expect(s.next?.id).toBe('b');
    expect(s.today.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('winter break between the semesters is "no class today" (not before/after the term)', () => {
    expect(getStatus(at('2027-01-05T10:00:00+08:00'), term).kind).toBe('no-class-today');
  });
});

describe('getStatus: boundaries and day edges', () => {
  it('starts exactly at the start instant and ends exactly at the end instant', () => {
    const start = at('2026-11-12T10:00:00+08:00');
    const end = at('2026-11-12T13:00:00+08:00');
    expect(getStatus(start - 1, term).kind).toBe('break');
    expect(getStatus(start, term).kind).toBe('in-class');
    expect(getStatus(end - 1, term).kind).toBe('in-class');
    expect(getStatus(end, term).kind).toBe('done-today');
  });

  it('on the first class day before class it is "break", on the last class day after class "done-today"', () => {
    expect(getStatus(at('2026-09-03T08:00:00+08:00'), term).kind).toBe('break');
    expect(getStatus(at('2026-09-02T23:59:00+08:00'), term).kind).toBe('before-term');
    expect(getStatus(at('2027-04-26T13:00:00+08:00'), term).kind).toBe('done-today');
    expect(getStatus(at('2027-04-27T00:00:00+08:00'), term).kind).toBe('after-term');
  });

  it('a class that crosses midnight is still in progress after midnight', () => {
    const night = [mk('n', '2026-11-12T23:00:00+08:00', '2026-11-13T01:00:00+08:00')];
    expect(getStatus(at('2026-11-13T00:30:00+08:00'), night).kind).toBe('in-class');
    expect(getStatus(at('2026-11-13T00:30:00+08:00'), night).today).toEqual([]);
  });

  it('an empty timetable is "before-term"', () => {
    expect(getStatus(at('2026-11-12T10:00:00+08:00'), []).kind).toBe('before-term');
  });

  it('does not depend on the order of the input array', () => {
    const shuffled = term.slice().reverse();
    expect(getStatus(at('2026-11-12T10:30:00+08:00'), shuffled).current?.id).toBe(THU);
  });
});

describe('getStatus: overlapping and marked sessions', () => {
  const overlap = fixtureSessions('overlap.ics'); // A 10-12 (MFIN7001), B 11-13 (MFIN7002)
  const A = overlap[0].id;
  const B = overlap[1].id;
  const now = at('2026-11-12T11:30:00+08:00');

  it('shows the session that started first and offers the other as an alternative', () => {
    const s = getStatus(now, overlap);
    expect(s.current?.id).toBe(A);
    expect(s.alsoActive.map((x) => x.id)).toEqual([B]);
  });

  it('prefers the session that is not marked as skipped', () => {
    const s = getStatus(now, overlap, { [A]: { status: 'skipped' } });
    expect(s.current?.id).toBe(B);
    expect(s.alsoActive.map((x) => x.id)).toEqual([A]);
  });

  it('keeps the first one when both are skipped', () => {
    const s = getStatus(now, overlap, { [A]: { status: 'skipped' }, [B]: { status: 'skipped' } });
    expect(s.current?.id).toBe(A);
  });

  it('ignores a cancelled session for "current" but keeps it in today', () => {
    const s = getStatus(now, overlap, { [A]: { status: 'cancelled' } });
    expect(s.current?.id).toBe(B);
    expect(s.alsoActive).toEqual([]);
    expect(s.today.map((x) => x.id)).toEqual([A, B]);
  });

  it('a cancelled class makes the day a no-class day', () => {
    const s = getStatus(at('2026-11-12T10:30:00+08:00'), term, { [THU]: { status: 'cancelled' } });
    expect(s.kind).toBe('no-class-today');
    expect(s.today.map((x) => x.id)).toEqual([THU]);
    expect(s.prev?.startMs).toBe(at('2026-11-09T09:00:00+08:00'));
  });

  it('a skipped class is still "in class" when it is the only one', () => {
    const s = getStatus(at('2026-11-12T10:30:00+08:00'), term, { [THU]: { status: 'skipped' } });
    expect(s.kind).toBe('in-class');
    expect(s.current?.id).toBe(THU);
  });
});
