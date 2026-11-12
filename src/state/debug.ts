// `window.__tt_debug`: development-only information for tests and manual checks. main.tsx installs it only when
// `import.meta.env.DEV` is true, so production bundles do not contain it.

import { parseDevNow, type Clock } from './clock';
import { resetReminderState } from './reminders';
import { shareCardFacts } from './share';

export interface TtDebug {
  /** Number of clock updates so far (animation frames while visible, 1 s ticks while hidden). */
  readonly ticks: number;
  /** The app's current `now` (UTC ms). */
  readonly now: number;
  readonly frozen: boolean;
  /** Fake time minus real time in ms. */
  readonly offsetMs: number;
  /** Jump the fake time to an ISO-8601 string (a `+` in the zone must be written as is, not URL-encoded) or UTC ms; returns the ms or null. */
  setNow(value: string | number): number | null;
  /** Forget which class reminders were already shown (they are remembered per tab, in sessionStorage), so a test can fire them again. */
  resetReminders(): void;
  /** Draw the share card and report its PNG facts: size, type, bytes, file name and every drawn text. */
  shareCard(): Promise<Awaited<ReturnType<typeof shareCardFacts>>>;
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
    setNow(value) {
      const ms = typeof value === 'number' ? value : parseDevNow(value);
      if (ms === null || !Number.isFinite(ms)) return null;
      clock.setFake(ms);
      return ms;
    },
    resetReminders: () => resetReminderState(),
    shareCard: () => shareCardFacts(),
  };
  window.__tt_debug = debug;
  return debug;
}
