// The global `now` signal (UTC milliseconds).
//
//  - Page in the foreground: updated on every animation frame.
//  - Page hidden (`document.hidden`): updated once per second (browsers throttle frames and timers in background
//    tabs anyway; the explicit 1 s timer keeps the page cheap and predictable).
//  - Page visible again: updated immediately, then back to per-frame updates.
//  - Development builds only (never in production): `?now=<ISO-8601>` fakes the current time (no zone suffix =
//    browser local time; the clock keeps running from that moment) and `&freeze=1` stops it.
//
// All browser access goes through `ClockEnv`, so tests can drive the clock with fake timers.

import { signal, type ReadonlySignal } from '@preact/signals';

export interface ClockEnv {
  raf(cb: () => void): number;
  caf(id: number): void;
  setInterval(cb: () => void, ms: number): number;
  clearInterval(id: number): void;
  isHidden(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe function. */
  onVisibilityChange(cb: () => void): () => void;
}

export interface ClockOptions {
  /** Allow `?now=` / `&freeze=1`. Default: the build's `import.meta.env.DEV` (always false in production). */
  dev?: boolean;
  /** Query string of the page (`location.search`). */
  search?: string;
  env?: Partial<ClockEnv>;
  /** Real time source, default `Date.now`. */
  realNow?: () => number;
}

export interface Clock {
  now: ReadonlySignal<number>;
  /** How many times the clock has been updated (frames + timer ticks). */
  ticks(): number;
  frozen: boolean;
  /** Fake time minus real time, in ms (0 when no fake time is in use). */
  offsetMs: number;
  start(): void;
  stop(): void;
}

/** Parse the value of `?now=`. A value without a zone suffix is local time. Returns null when unusable. */
export function parseDevNow(raw: string | null): number | null {
  if (!raw) return null;
  let text = raw.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  // "+08:00" in a query string arrives as " 08:00" (a plus sign decodes to a space).
  text = text.replace(/T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s(\d{2}:?\d{2})$/, 'T$1+$2');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = `${text}T00:00:00`;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function defaultEnv(): ClockEnv {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (id: number) => void;
    document?: Document;
  };
  return {
    raf: (cb) => (g.requestAnimationFrame ? g.requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)),
    caf: (id) => (g.cancelAnimationFrame ? g.cancelAnimationFrame(id) : clearTimeout(id)),
    setInterval: (cb, ms) => setInterval(cb, ms) as unknown as number,
    clearInterval: (id) => clearInterval(id),
    isHidden: () => g.document?.hidden === true,
    onVisibilityChange: (cb) => {
      g.document?.addEventListener('visibilitychange', cb);
      return () => g.document?.removeEventListener('visibilitychange', cb);
    },
  };
}

export function createClock(options: ClockOptions = {}): Clock {
  const realNow = options.realNow ?? (() => Date.now());
  let frozenAt: number | null = null;
  let offsetMs = 0;

  // The `import.meta.env.DEV &&` guard lets the production build drop this block entirely.
  if (import.meta.env.DEV && options.dev !== false) {
    const params = new URLSearchParams(options.search ?? '');
    const fake = parseDevNow(params.get('now'));
    if (fake !== null) {
      offsetMs = fake - realNow();
      if (params.get('freeze') === '1') frozenAt = fake;
    }
  }

  const current = (): number => (frozenAt !== null ? frozenAt : realNow() + offsetMs);
  const now = signal(current());
  let tickCount = 0;
  let env: ClockEnv | null = null;
  let rafId: number | null = null;
  let intervalId: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let running = false;

  const update = (): void => {
    tickCount += 1;
    now.value = current();
  };

  const frame = (): void => {
    update();
    if (running && env) rafId = env.raf(frame);
  };

  const stopTimers = (): void => {
    if (env && rafId !== null) env.caf(rafId);
    if (env && intervalId !== null) env.clearInterval(intervalId);
    rafId = null;
    intervalId = null;
  };

  const applyVisibility = (): void => {
    if (!env) return;
    stopTimers();
    if (env.isHidden()) {
      intervalId = env.setInterval(update, 1000);
    } else {
      update(); // back in the foreground: show the right time at once
      rafId = env.raf(frame);
    }
  };

  return {
    now,
    ticks: () => tickCount,
    get frozen() {
      return frozenAt !== null;
    },
    get offsetMs() {
      return offsetMs;
    },
    start() {
      if (running) return;
      running = true;
      env = { ...defaultEnv(), ...options.env };
      unsubscribe = env.onVisibilityChange(applyVisibility);
      applyVisibility();
    },
    stop() {
      running = false;
      stopTimers();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/** The app-wide clock. Started by `main.tsx`. */
export const clock = createClock({ dev: import.meta.env.DEV, search: (globalThis as { location?: Location }).location?.search ?? '' });
export const now = clock.now;
