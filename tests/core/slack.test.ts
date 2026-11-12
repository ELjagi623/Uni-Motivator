import { describe, expect, it } from 'vitest';
import { buildPools, getPoolSession } from '../../src/core/billing';
import {
  closeFinishedSlacks,
  isSlackRunning,
  slackAmountMinor,
  slackInterval,
  slackSeconds,
  slackSecondsBySession,
  type SlackSession,
} from '../../src/core/slack';
import type { SlackRecord } from '../../src/core/types';
import { at, fixtureSessions, NORTHERN } from './helpers';

const session: SlackSession = { id: 's1', startMs: at('2026-11-12T10:00:00+08:00'), endMs: at('2026-11-12T13:00:00+08:00') };
const rec = (over: Partial<SlackRecord> = {}): SlackRecord => ({ id: 'r1', sessionId: 's1', startMs: at('2026-11-12T10:30:00+08:00'), ...over });

describe('slack amount = unit price x overlapping seconds', () => {
  const rate = 36.85185185; // minor units per second (HK$398,000 over 1,080,000 s)

  it('counts a finished slack record in full', () => {
    const r = rec({ endMs: at('2026-11-12T10:40:00+08:00') });
    expect(slackSeconds(r, session, at('2026-11-12T12:00:00+08:00'))).toBe(600);
    expect(slackAmountMinor(r, session, rate, at('2026-11-12T12:00:00+08:00'))).toBe(Math.round(rate * 600));
  });

  it('counts a running record up to `now`', () => {
    expect(slackSeconds(rec(), session, at('2026-11-12T10:31:00+08:00'))).toBe(60);
    expect(slackSeconds(rec(), session, at('2026-11-12T10:30:00+08:00'))).toBe(0);
    expect(slackSeconds(rec(), session, at('2026-11-12T10:29:00+08:00'))).toBe(0);
  });

  it('does not count time beyond the end of the class', () => {
    const r = rec({ endMs: at('2026-11-12T15:00:00+08:00') });
    expect(slackSeconds(r, session, at('2026-11-12T16:00:00+08:00'))).toBe(2.5 * 3600);
    // a running record opened late and never closed: capped at the class end too
    expect(slackSeconds(rec(), session, at('2026-11-13T10:00:00+08:00'))).toBe(2.5 * 3600);
  });

  it('does not count time before the class starts', () => {
    const r = rec({ startMs: at('2026-11-12T09:00:00+08:00'), endMs: at('2026-11-12T10:30:00+08:00') });
    expect(slackSeconds(r, session, at('2026-11-12T12:00:00+08:00'))).toBe(1800);
    expect(slackInterval(r, session, 0)).toEqual({ fromMs: session.startMs, toMs: at('2026-11-12T10:30:00+08:00') });
  });

  it('has no overlap for a record entirely outside the class or with an end before its start', () => {
    expect(slackInterval(rec({ startMs: at('2026-11-12T14:00:00+08:00'), endMs: at('2026-11-12T15:00:00+08:00') }), session, 0)).toBeNull();
    expect(slackSeconds(rec({ endMs: at('2026-11-12T10:00:00+08:00') }), session, 0)).toBe(0);
  });

  it('uses the real unit price of the session from the billing pools', () => {
    const term = fixtureSessions('full-term.ics');
    const [pool] = buildPools(term, { academic: NORTHERN, tuition: { defaultMinor: 39_800_000 } });
    const ps = getPoolSession(pool, 'ft-thu-s1@fixture|2026-11-12T02:00:00Z')!;
    const r: SlackRecord = { id: 'x', sessionId: ps.id, startMs: ps.startMs + 600_000, endMs: ps.startMs + 1_200_000 };
    expect(slackAmountMinor(r, ps, ps.ratePerSec, ps.endMs)).toBe(Math.round(ps.ratePerSec * 600));
  });
});

describe('auto-truncation of unfinished records', () => {
  const sessions = new Map<string, SlackSession>([['s1', session]]);

  it('sets endMs to the class end once the class is over (also when the page was closed meanwhile)', () => {
    const records = [rec(), rec({ id: 'r2', endMs: at('2026-11-12T11:00:00+08:00') })];
    const { records: out, changed } = closeFinishedSlacks(records, sessions, at('2026-11-12T20:00:00+08:00'));
    expect(out[0].endMs).toBe(session.endMs);
    expect(out[1].endMs).toBe(at('2026-11-12T11:00:00+08:00'));
    expect(changed).toEqual([out[0]]);
    expect(records[0].endMs).toBeUndefined(); // input untouched
  });

  it('leaves running records of classes that are still in progress, and records of unknown sessions', () => {
    const records = [rec(), rec({ id: 'r3', sessionId: 'gone' })];
    const { records: out, changed } = closeFinishedSlacks(records, sessions, at('2026-11-12T12:59:59+08:00'));
    expect(out).toEqual(records);
    expect(changed).toEqual([]);
    expect(closeFinishedSlacks(records, sessions, session.endMs).changed.map((r) => r.id)).toEqual(['r1']);
  });

  it('never produces an end before the start', () => {
    const late = rec({ startMs: at('2026-11-12T14:00:00+08:00') });
    expect(closeFinishedSlacks([late], sessions, at('2026-11-12T20:00:00+08:00')).records[0].endMs).toBe(late.startMs);
  });
});

describe('isSlackRunning / per-session totals', () => {
  it('is running only without endMs and before the class ends', () => {
    expect(isSlackRunning(rec(), session, session.endMs - 1)).toBe(true);
    expect(isSlackRunning(rec(), session, session.endMs)).toBe(false);
    expect(isSlackRunning(rec({ endMs: 1 }), session, 0)).toBe(false);
    expect(isSlackRunning(rec(), undefined, 0)).toBe(true);
  });

  it('adds up several records of one session', () => {
    const records = [rec({ id: 'a', endMs: at('2026-11-12T10:40:00+08:00') }), rec({ id: 'b', startMs: at('2026-11-12T11:00:00+08:00'), endMs: at('2026-11-12T11:05:00+08:00') }), rec({ id: 'c', sessionId: 'unknown' })];
    const totals = slackSecondsBySession(records, new Map([['s1', session]]), session.endMs);
    expect([...totals.entries()]).toEqual([['s1', 900]]);
  });
});
