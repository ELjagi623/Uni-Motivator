// The data the app is currently showing: the real documents, or the in-memory sample while in demo mode.
// Everything that displays data (derived values, dashboard, slacking, tab title) reads from here.

import { computed } from '@preact/signals';
import { calendars, config, marks, slacks } from './data';
import { demoActive, demoData, demoMarks, demoSlacks } from './demoState';

export const activeConfig = computed(() => (demoActive.value && demoData.value ? demoData.value.config : config.value));
export const activeCalendars = computed(() => (demoActive.value && demoData.value ? demoData.value.calendars : calendars.value));
export const activeMarks = computed(() => (demoActive.value ? demoMarks.value : marks.value));
export const activeSlacks = computed(() => (demoActive.value ? demoSlacks.value : slacks.value));
