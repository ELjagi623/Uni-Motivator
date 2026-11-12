// `window.__tt_debug`: development-only information for tests and manual checks. main.tsx installs it only when
// `import.meta.env.DEV` is true, so production bundles do not contain it.

import type { Clock } from './clock';

export interface TtDebug {
  /** Number of clock updates so far (animation frames while visible, 1 s ticks while hidden). */
  readonly ticks: number;
  /** The app's current `now` (UTC ms). */
  readonly now: number;
  readonly frozen: boolean;
  /** Fake time minus real time in ms. */
  readonly offsetMs: number;
}

declare global {
  interface Window {
    __tt_debug?: TtDebug;
  }
}

export function installDebug(clock: Clock): TtDebug {
  const debug: TtDebug = {
    get ticks() {
      return clock.ticks();
    },
    get now() {
      return clock.now.value;
    },
    get frozen() {
      return clock.frozen;
    },
    get offsetMs() {
      return clock.offsetMs;
    },
  };
  window.__tt_debug = debug;
  return debug;
}
