import { describe, expect, it } from 'vitest';

// Smoke test of the Vitest config: every test run must be pinned to Asia/Hong_Kong (UTC+8, no DST).
describe('vitest environment', () => {
  it('runs with TZ=Asia/Hong_Kong', () => {
    expect(process.env.TZ).toBe('Asia/Hong_Kong');
    expect(new Date(Date.UTC(2026, 10, 12, 2, 30)).getTimezoneOffset()).toBe(-480);
    expect(new Date(Date.UTC(2026, 6, 1, 2, 30)).getTimezoneOffset()).toBe(-480);
  });

  it('formats local time using the pinned zone', () => {
    const d = new Date('2026-11-12T10:30:00+08:00');
    expect(d.getHours()).toBe(10);
    expect(d.getMinutes()).toBe(30);
  });
});
