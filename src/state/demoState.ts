// The signals behind demo mode. Kept apart from demo.ts (which bundles the sample calendar with Vite's `?raw`) so that
// the rest of the state layer, and the scripts that import it with tsx, never need to load the sample file.

import { signal } from '@preact/signals';
import type { CalendarFile } from '../api/client';
import type { AppConfig } from './config';
import type { DocValue } from './data';

export interface DemoData {
  config: AppConfig;
  calendars: CalendarFile[];
  /** UTC ms: 70 minutes into the 7th class of the first course. */
  nowMs: number;
}

export const demoActive = signal(false);
/** The sample data while demo mode is on (set by enterDemo), otherwise null. */
export const demoData = signal<DemoData | null>(null);
/** Added to the clock while in demo mode, so that demo time starts at `DemoData.nowMs` and then keeps running. */
export const demoShiftMs = signal(0);
export const demoMarks = signal<DocValue>({ schemaVersion: 1 });
export const demoSlacks = signal<DocValue>({ schemaVersion: 1 });
