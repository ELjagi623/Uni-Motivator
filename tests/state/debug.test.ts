// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClock } from '../../src/state/clock';
import { installDebug } from '../../src/state/debug';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(new Date('2026-11-12T03:00:00Z'));
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

afterEach(() => {
  vi.useRealTimers();
  delete window.__tt_debug;
});

describe('window.__tt_debug.ticks (background throttling)', () => {
  it('exposes the clock update count, now, frozen and the offset', () => {
    const clock = createClock({ search: '?now=2026-11-12T10:30:00%2B08:00&freeze=1' });
    const debug = installDebug(clock);
    expect(window.__tt_debug).toBe(debug);
    expect(typeof debug.ticks).toBe('number');
    expect(debug.frozen).toBe(true);
    expect(debug.now).toBe(Date.parse('2026-11-12T10:30:00+08:00'));
    clock.start();
    const before = debug.ticks;
    vi.advanceTimersByTime(200);
    expect(debug.ticks).toBeGreaterThan(before); // it counts updates, even while frozen
    clock.stop();
  });

  it('in the background at most 12 updates in 10 seconds, in the foreground far more; the page is right the moment it is shown again', () => {
    const clock = createClock({ dev: false });
    const debug = installDebug(clock);
    clock.start();

    let mark = debug.ticks;
    vi.advanceTimersByTime(10_000);
    const foreground = debug.ticks - mark;

    setHidden(true);
    mark = debug.ticks;
    vi.advanceTimersByTime(10_000);
    const background = debug.ticks - mark;
    expect(background).toBeLessThanOrEqual(12);
    expect(background).toBeGreaterThanOrEqual(8); // it still keeps time, once a second
    expect(foreground).toBeGreaterThan(background * 10); // ~600 frames vs ~10 ticks

    // a long sleep in the background: the first update after returning shows the right time at once
    vi.setSystemTime(Date.now() + 3_600_000);
    setHidden(false);
    expect(Math.abs(Date.now() - debug.now)).toBeLessThan(20);
    clock.stop();
  });
});
