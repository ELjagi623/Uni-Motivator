import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { billingStateAt, findPoolOfSession, getPoolSession, summarizeMarks } from '../../src/core/billing';
import { marksOf } from '../../src/state/dashboard';
import { dashboardInputs } from '../../src/state/dashboardState';
import { billableSessions, pools } from '../../src/state/derived';
import { flushSaves, loadAll, marks, resetDataState } from '../../src/state/data';
import { setMark, toggleMark } from '../../src/state/marks';
import { marksSummaryAt } from '../../src/state/sessions';
import { installFakeServer, type FakeServer } from './fake-server';
import { fixtureConfig, fullTermText, hk } from './fixture-app';

let server: FakeServer;

const SESSION_ID = /^[^|\s]+\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TUITION_ALL = 2 * 39_800_000;

beforeEach(async () => {
  resetDataState();
  server = installFakeServer({ config: fixtureConfig() as unknown as Record<string, unknown> }, [{ id: 'cal-0', text: fullTermText }]);
  await loadAll();
});

afterEach(() => {
  server.restore();
});

/** Two sessions that are over by 2026-11-20: the 3rd and the 10th of the class list. */
function pick() {
  const over = billableSessions.value.filter((s) => s.endMs < hk('2026-11-20T00:00:00'));
  return { skipped: over[3], cancelled: over[10], all: over };
}

describe('marks: writing', () => {
  it('PUTs marks.json keyed by session id (UID|original start UTC) with the status', async () => {
    const { skipped, cancelled } = pick();
    setMark(skipped.id, 'skipped');
    setMark(cancelled.id, 'cancelled');
    await flushSaves();

    const puts = server.puts('marks');
    expect(puts).toHaveLength(1); // two changes in a burst are one request
    const doc = (puts[0].json as { doc: { schemaVersion: number; marks: Record<string, { status: string }> } }).doc;
    expect(Object.keys(doc.marks).sort()).toEqual([skipped.id, cancelled.id].sort());
    for (const id of Object.keys(doc.marks)) expect(id).toMatch(SESSION_ID);
    expect(doc.marks[skipped.id]).toEqual({ status: 'skipped' });
    expect(doc.marks[cancelled.id]).toEqual({ status: 'cancelled' });
    expect(server.docs.marks.marks).toEqual(doc.marks);
  });

  it('clears a mark again and leaves nothing behind (toggle and explicit clear)', async () => {
    const { skipped } = pick();
    toggleMark(skipped.id, 'skipped');
    expect(marksOf(marks.value)[skipped.id]?.status).toBe('skipped');
    toggleMark(skipped.id, 'skipped');
    expect(marksOf(marks.value)).toEqual({});
    setMark(skipped.id, 'cancelled');
    setMark(skipped.id, 'skipped'); // switching straight from one status to the other
    expect(marksOf(marks.value)[skipped.id]).toEqual({ status: 'skipped' });
    setMark(skipped.id, null);
    await flushSaves();
    expect((server.docs.marks.marks as object) ?? {}).toEqual({});
  });

  it('keeps the other fields of a mark (late / early minutes arrive in a later phase)', () => {
    const { skipped } = pick();
    marks.value = { schemaVersion: 1, marks: { [skipped.id]: { status: 'skipped', lateMin: 10 } } };
    setMark(skipped.id, null);
    expect(marksOf(marks.value)[skipped.id]).toEqual({ lateMin: 10 });
  });
});

describe('marks: billing invariants', () => {
  it('marking changes no unit price and consumed + remaining stays equal to the tuition at random instants', async () => {
    const before = pools.value;
    const rates = before.flatMap((p) => p.sessions.map((s) => [s.id, s.ratePerSec, s.costMinor] as const));
    const { skipped, cancelled } = pick();
    setMark(skipped.id, 'skipped');
    setMark(cancelled.id, 'cancelled');
    await flushSaves();

    expect(pools.value).toBe(before); // billing never even looks at marks
    expect(before.flatMap((p) => p.sessions.map((s) => [s.id, s.ratePerSec, s.costMinor] as const))).toEqual(rates);

    let seed = 20261112;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const from = hk('2026-08-01T00:00:00');
    const to = hk('2027-07-01T00:00:00');
    for (let i = 0; i < 300; i++) {
      const nowMs = Math.floor(from + rand() * (to - from));
      const st = billingStateAt(pools.value, nowMs);
      expect(st.tuitionMinor).toBe(TUITION_ALL);
      expect(st.consumedMinor + st.remainingMinor).toBe(TUITION_ALL);
    }
  });

  it('skipped-loss and swallowed-tuition equal core\'s summary, and unmarking restores zero', async () => {
    const { skipped, cancelled, all } = pick();
    const nowMs = hk('2026-11-20T00:00:00');
    const costOf = (id: string) => getPoolSession(findPoolOfSession(pools.value, id)!, id)!.costMinor;

    setMark(skipped.id, 'skipped');
    setMark(cancelled.id, 'cancelled');
    const view = marksSummaryAt(dashboardInputs.value, nowMs);
    const core = summarizeMarks(pools.value, marksOf(marks.value), { asOfMs: nowMs }).total;
    expect(view.skippedMinor).toBe(core.skippedMinor);
    expect(view.cancelledMinor).toBe(core.cancelledMinor);
    expect(view.skippedMinor).toBe(costOf(skipped.id));
    expect(view.cancelledMinor).toBe(costOf(cancelled.id));
    expect(view.attendanceRate).toBeCloseTo((all.length - 2) / (all.length - 1), 10);
    expect(view.attendanceText).toBe(`${Math.round(((all.length - 2) / (all.length - 1)) * 100)}%`);

    setMark(skipped.id, null);
    setMark(cancelled.id, null);
    const cleared = marksSummaryAt(dashboardInputs.value, nowMs);
    expect(cleared.skippedMinor).toBe(0);
    expect(cleared.cancelledMinor).toBe(0);
    expect(cleared.attendanceRate).toBe(1);
  });
});
