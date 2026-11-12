// Demo mode: a fictional timetable (examples/sample-calendar.ics, bundled with ?raw) and a fake `now` that falls in
// the middle of a class, so the dashboard and the slacking page can be tried before anything is imported.
// Everything lives in memory: demo mode never writes to the data folder.

import { assignCourses, courseFromGroup, groupSessions, sessionsOfCourses } from '../core/courses';
import { expandIcs } from '../core/ics/expand';
import sampleIcs from '../../examples/sample-calendar.ics?raw';
import { clock } from './clock';
import { defaultAcademic } from './config';
import { demoActive, demoData, demoMarks, demoShiftMs, demoSlacks, type DemoData } from './demoState';

export const DEMO_CALENDAR_ID = 'demo-sample';
const DEMO_TUITION_MINOR = 39_800_000; // HK$398,000.00 per semester
const SESSION_INDEX = 6; // the 7th class of the first course
const MINUTES_INTO_CLASS = 70;

let cached: DemoData | null = null;

export function getDemoData(): DemoData {
  if (cached) return cached;
  const sessions = expandIcs(sampleIcs);
  const courses = groupSessions(sessions)
    .filter((g) => g.suggested)
    .map((g, i) => courseFromGroup(g, { colorIndex: i, credits: 3 }));
  const billable = sessionsOfCourses(sessions, courses);
  const assigned = assignCourses(billable, courses);
  const ofFirst = billable.filter((s) => assigned.get(s.id) === courses[0].id);
  const anchor = ofFirst[Math.min(SESSION_INDEX, ofFirst.length - 1)] ?? billable[0];
  cached = {
    config: {
      schemaVersion: 1,
      onboardingDone: true,
      school: '',
      region: 'northern',
      currency: 'HKD',
      academic: defaultAcademic(),
      billingMode: 'duration',
      tuition: { defaultMinor: DEMO_TUITION_MINOR, byPool: {} },
      courses,
      calendars: [{ id: DEMO_CALENDAR_ID, name: 'sample-calendar.ics' }],
    },
    calendars: [{ id: DEMO_CALENDAR_ID, text: sampleIcs }],
    nowMs: anchor.startMs + MINUTES_INTO_CLASS * 60_000,
  };
  return cached;
}

export function enterDemo(): void {
  const data = getDemoData();
  demoData.value = data;
  demoShiftMs.value = data.nowMs - clock.now.peek();
  demoMarks.value = { schemaVersion: 1 };
  demoSlacks.value = { schemaVersion: 1 };
  demoActive.value = true;
}

export function exitDemo(): void {
  demoActive.value = false;
  demoData.value = null;
}

export { demoActive };
