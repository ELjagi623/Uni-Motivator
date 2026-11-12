import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandIcs } from '../../src/core/ics/expand';
import type { AcademicConfig, Session } from '../../src/core/types';

export const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

export function fixtureSessions(name: string): Session[] {
  return expandIcs(readFixture(name));
}

/** Parse an ISO timestamp with offset into UTC ms. */
export const at = (iso: string): number => Date.parse(iso);

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NORTHERN: AcademicConfig = { yearStart: '08-01', splitDate: '12-25', billingPeriod: 'semester' };
export const NORTHERN_YEAR: AcademicConfig = { ...NORTHERN, billingPeriod: 'year' };
export const SOUTHERN: AcademicConfig = { yearStart: '01-01', splitDate: '07-01', billingPeriod: 'semester' };

/** Make `n` plain sessions of `hours` each, one per day starting 09:00 HK on `firstDay` (YYYY-MM-DD). */
export function dailySessions(firstDay: string, n: number, hours: number, prefix = 's'): Session[] {
  const out: Session[] = [];
  const first = Date.parse(`${firstDay}T09:00:00+08:00`);
  for (let i = 0; i < n; i++) {
    const startMs = first + i * 86_400_000;
    out.push({
      id: `${prefix}${i}|${iso(startMs)}`,
      uid: `${prefix}${i}`,
      title: 'Test',
      location: '',
      startMs,
      endMs: startMs + hours * 3_600_000,
    });
  }
  return out;
}
