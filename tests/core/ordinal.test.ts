import { describe, expect, it } from 'vitest';
import { sessionOrdinal } from '../../src/core/ordinal';

const s = (id: string, startMs: number, courseId: string | null) => ({ id, startMs, courseId });

describe('sessionOrdinal', () => {
  const list = [s('b2', 200, 'B'), s('a1', 100, 'A'), s('a3', 300, 'A'), s('a2', 150, 'A'), s('b1', 120, 'B')];

  it('counts a session among the sessions of its own course, ordered by start time (input order does not matter)', () => {
    expect(sessionOrdinal(list, 'a1')).toEqual({ index: 1, total: 3 });
    expect(sessionOrdinal(list, 'a2')).toEqual({ index: 2, total: 3 });
    expect(sessionOrdinal(list, 'a3')).toEqual({ index: 3, total: 3 });
    expect(sessionOrdinal(list, 'b2')).toEqual({ index: 2, total: 2 });
  });

  it('breaks ties between equal start times by id so the result is stable', () => {
    const tie = [s('y', 100, 'A'), s('x', 100, 'A')];
    expect(sessionOrdinal(tie, 'x')).toEqual({ index: 1, total: 2 });
    expect(sessionOrdinal(tie, 'y')).toEqual({ index: 2, total: 2 });
  });

  it('returns null for an unknown session or one without a course', () => {
    expect(sessionOrdinal(list, 'nope')).toBeNull();
    expect(sessionOrdinal([s('x', 1, null), s('y', 2, undefined as unknown as null)], 'x')).toBeNull();
    expect(sessionOrdinal([s('y', 2, undefined as unknown as null)], 'y')).toBeNull();
  });
});
