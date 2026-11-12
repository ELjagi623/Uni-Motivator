// The app's current time. Kept apart from source.ts so that the data selectors (and the scripts that import them)
// do not pull in the browser clock.

import { computed, signal } from '@preact/signals';
import { clock } from './clock';
import { demoActive, demoShiftMs } from './demoState';

/** Tests set this to pin the app's time; null in the app. */
export const nowOverride = signal<number | null>(null);

/** The app's current time (UTC ms): the clock, shifted to the demo moment while in demo mode. */
export const activeNow = computed(() => nowOverride.value ?? clock.now.value + (demoActive.value ? demoShiftMs.value : 0));

/** Changes once a minute. Components that read it re-render at most once a minute (e.g. the aria-live summary). */
export const minuteBucket = computed(() => Math.floor(activeNow.value / 60_000));
