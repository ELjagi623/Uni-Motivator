// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClock, parseDevNow } from '../../src/state/clock';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(new Date('2026-11-12T09:00:00Z'));
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clock: foreground and background', () => {
  it('updates on animation frames while the page is visible', () => {
    const clock = createClock({ dev: false });
    clock.start();
    const before = clock.ticks();
    vi.advanceTimersByTime(1000);
    const frames = clock.ticks() - before;
    expect(frames).toBeGreaterThan(30); // ~60 frames per second
    expect(Date.now() - clock.now.value).toBeLessThan(20);
    clock.stop();
  });

  it('updates at most once per second while hidden (at most 6 times in 5 seconds)', () => {
    const clock = createClock({ dev: false });
    clock.start();
    setHidden(true);
    const before = clock.ticks();
    vi.advanceTimersByTime(5000);
    const hiddenTicks = clock.ticks() - before;
    expect(hiddenTicks).toBeLessThanOrEqual(6);
    expect(hiddenTicks).toBeGreaterThanOrEqual(4);
    expect(Date.now() - clock.now.value).toBeLessThan(20);
    clock.stop();
  });

  it('updates immediately when the page becomes visible again, then resumes per-frame updates', () => {
    const clock = createClock({ dev: false });
    clock.start();
    setHidden(true);
    vi.advanceTimersByTime(300); // a moment between two 1 s ticks
    const staleNow = clock.now.value;
    vi.setSystemTime(Date.now() + 30_000); // e.g. the laptop slept while the tab was hidden
    const ticksBefore = clock.ticks();
    setHidden(false);
    expect(clock.ticks()).toBe(ticksBefore + 1); // immediate update, no waiting for a frame
    expect(Date.now() - clock.now.value).toBeLessThan(20);
    expect(clock.now.value).toBeGreaterThan(staleNow);
    vi.advanceTimersByTime(200);
    expect(clock.ticks()).toBeGreaterThan(ticksBefore + 3);
    clock.stop();
  });

  it('stops everything on stop()', () => {
    const clock = createClock({ dev: false });
    clock.start();
    clock.stop();
    const before = clock.ticks();
    vi.advanceTimersByTime(3000);
    setHidden(true);
    vi.advanceTimersByTime(3000);
    expect(clock.ticks()).toBe(before);
  });
});

describe('clock: development time parameters', () => {
  const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

  it('?now=...&freeze=1 pins the clock at that instant (local time when no zone is given)', () => {
    const clock = createClock({ search: '?now=2026-11-12T10:30:00&freeze=1' });
    clock.start();
    expect(clock.now.value).toBe(local(2026, 11, 12, 10, 30));
    vi.advanceTimersByTime(5000);
    expect(clock.now.value).toBe(local(2026, 11, 12, 10, 30));
    expect(clock.frozen).toBe(true);
    clock.stop();
  });

  it('?now=... without freeze starts there and then advances one second per second', () => {
    const clock = createClock({ search: '?now=2026-11-12T10:30:00' });
    clock.start();
    expect(clock.now.value).toBe(local(2026, 11, 12, 10, 30));
    vi.advanceTimersByTime(5000);
    expect(clock.now.value).toBeGreaterThanOrEqual(local(2026, 11, 12, 10, 30, 4));
    expect(clock.now.value).toBeLessThanOrEqual(local(2026, 11, 12, 10, 30, 5));
    expect(clock.frozen).toBe(false);
    clock.stop();
  });

  it('ignores both parameters when development mode is off (production behaviour)', () => {
    const clock = createClock({ dev: false, search: '?now=2026-11-12T10:30:00&freeze=1' });
    clock.start();
    expect(Date.now() - clock.now.value).toBeLessThan(20);
    expect(clock.frozen).toBe(false);
    expect(clock.offsetMs).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(Date.now() - clock.now.value).toBeLessThan(20);
    clock.stop();
  });

  it('ignores an unusable ?now= value', () => {
    const clock = createClock({ search: '?now=tomorrow&freeze=1' });
    expect(Date.now() - clock.now.value).toBeLessThan(20);
    expect(clock.frozen).toBe(false);
  });

  it('parses ISO values with and without zone suffixes, including a "+" that the query string turned into a space', () => {
    expect(parseDevNow('2026-11-12T10:30:00Z')).toBe(Date.UTC(2026, 10, 12, 10, 30));
    expect(parseDevNow('2026-11-12T10:30:00+08:00')).toBe(Date.UTC(2026, 10, 12, 2, 30));
    expect(new URLSearchParams('?now=2026-11-12T10:30:00+08:00').get('now')).toBe('2026-11-12T10:30:00 08:00');
    expect(parseDevNow(new URLSearchParams('?now=2026-11-12T10:30:00+08:00').get('now'))).toBe(Date.UTC(2026, 10, 12, 2, 30));
    expect(parseDevNow('2026-11-12T10:30:00')).toBe(new Date(2026, 10, 12, 10, 30).getTime());
    expect(parseDevNow('2026-11-12')).toBe(new Date(2026, 10, 12).getTime());
    expect(parseDevNow('nonsense')).toBeNull();
    expect(parseDevNow(null)).toBeNull();
  });
});
