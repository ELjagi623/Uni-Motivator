// Runs the engine over the user's real calendar files in test-data/private/ (never committed). The whole suite is
// skipped when the directory is missing or has no .zip / .ics files. Assertions only look at counts and invariants,
// and failure messages never contain calendar content: nothing here prints titles, codes, places or dates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSplitDate } from '../../src/core/academic';
import { billingStateAt, buildPools, poolStateAt } from '../../src/core/billing';
import { courseFromGroup, groupSessions, sessionsOfCourses } from '../../src/core/courses';
import { expandIcs, mergeSessions } from '../../src/core/ics/expand';
import { readCalendarFile } from '../../src/core/ics/unzip';
import { getRegionPreset } from '../../src/data/regions';

// TT_PRIVATE_DIR lets the acceptance script point the suite at an empty directory to prove it is skipped.
const dir = process.env.TT_PRIVATE_DIR
  ? path.resolve(process.env.TT_PRIVATE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-data', 'private');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(zip|ics)$/i.test(f)) : [];

describe.skipIf(files.length === 0)('real calendar in test-data/private (aggregate checks only)', () => {
  const sessions = mergeSessions(
    files.map((f) => readCalendarFile(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))).flatMap((e) => expandIcs(e.text))),
  );
  const groups = groupSessions(sessions);
  const courses = groups.filter((g) => g.suggested).map((g, i) => courseFromGroup(g, { colorIndex: i }));
  const billable = sessionsOfCourses(sessions, courses);
  const preset = getRegionPreset('northern');
  const tuition = 39_800_000;

  it('parses to sessions with unique ids and positive durations', () => {
    expect(sessions.length).toBeGreaterThan(0);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(sessions.length);
    expect(sessions.every((s) => s.endMs > s.startMs)).toBe(true);
  });

  it('suggests at least one course group', () => {
    expect(courses.length).toBeGreaterThanOrEqual(1);
    expect(billable.length).toBeGreaterThan(0);
  });

  for (const period of ['semester', 'year'] as const) {
    describe(`billing per ${period}`, () => {
      const academic = { yearStart: preset.yearStart, splitDate: preset.splitDate, billingPeriod: period };
      const pools = buildPools(billable, { academic, tuition: { defaultMinor: tuition } });

      it('puts every billable session into exactly one pool', () => {
        const ids = pools.flatMap((p) => p.sessions.map((s) => s.id));
        expect(ids.length).toBe(billable.length);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('has per-session costs that add up to the pool tuition (tolerance 1 minor unit)', () => {
        for (const p of pools) {
          const sum = p.sessions.reduce((a, s) => a + s.costMinor, 0);
          expect(Math.abs(sum - tuition)).toBeLessThanOrEqual(1);
          const exact = p.sessions.reduce((a, s) => a + s.costExact, 0);
          expect(Math.abs(exact - tuition)).toBeLessThanOrEqual(1);
        }
      });

      it('keeps consumed + remaining equal to the tuition and ends fully consumed', () => {
        for (const p of pools) {
          for (let i = 0; i <= 200; i++) {
            const now = p.firstStartMs + Math.round(((p.lastEndMs - p.firstStartMs) * i) / 200);
            const st = poolStateAt(p, now);
            expect(st.consumedMinor + st.remainingMinor).toBe(tuition);
          }
          expect(poolStateAt(p, p.lastEndMs).consumedMinor).toBe(tuition);
        }
        expect(billingStateAt(pools, Number.MAX_SAFE_INTEGER).remainingMinor).toBe(0);
      });
    });
  }

  it('gives a verdict for the split date of every academic year (inside the break, a suggestion, or a single-semester calendar)', () => {
    const results = checkSplitDate(billable, { yearStart: preset.yearStart, splitDate: preset.splitDate, billingPeriod: 'semester' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(['ok', 'suggest', 'single-semester', 'no-gap']).toContain(r.status);
      if (r.status === 'suggest') expect(r.suggestedSplit).toMatch(/^\d{2}-\d{2}$/);
    }
  });

  it('assigns each billable session to exactly one semester', () => {
    const academic = { yearStart: preset.yearStart, splitDate: preset.splitDate, billingPeriod: 'semester' as const };
    const pools = buildPools(billable, { academic, tuition: { defaultMinor: tuition } });
    const seen = new Map<string, number>();
    for (const p of pools) for (const s of p.sessions) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    expect(billable.every((s) => seen.get(s.id) === 1)).toBe(true);
  });
});
