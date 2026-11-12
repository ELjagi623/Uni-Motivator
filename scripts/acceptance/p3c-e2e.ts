// Builds, for a calendar source (a .ics / .zip file or a folder of them), what the first-run wizard would produce with
// tuition 398,000 HKD per semester and every suggested course ticked: a data folder (config.json + calendars/*.ics)
// and the wizard's step-7 preview numbers (computed by the UI state layer, `buildPreview`). Prints ONLY aggregate
// numbers (counts, hours, unit prices) as one JSON line, plus an instant in the middle of a class (`inClassIso`) that
// the acceptance script hands to `npm run query` without printing it. Nothing from the calendar's content is printed.
//
//   tsx scripts/acceptance/p3c-e2e.ts <file | folder> <output data folder> <TZ>

import fs from 'node:fs';
import path from 'node:path';
import { groupSessions } from '../../src/core/courses';
import { expandIcs, mergeSessions } from '../../src/core/ics/expand';
import { readCalendarFile } from '../../src/core/ics/unzip';
import type { Session } from '../../src/core/types';
import { billableOf } from '../../src/state/derived';
import { buildConfig, buildPreview, initialDraft } from '../../src/state/onboarding';

const [source, outDir, tz] = process.argv.slice(2);
process.env.TZ = tz;

const files = fs.statSync(source).isDirectory()
  ? fs
      .readdirSync(source)
      .filter((f) => /\.(zip|ics)$/i.test(f))
      .sort()
      .map((f) => path.join(source, f))
  : [source];

const texts: string[] = [];
for (const file of files) for (const entry of readCalendarFile(path.basename(file), new Uint8Array(fs.readFileSync(file)))) texts.push(entry.text);
const sessions: Session[] = mergeSessions(texts.map((t) => expandIcs(t)));
const groups = groupSessions(sessions);

const draft = { ...initialDraft(), tuitionText: '398000' };
const preview = buildPreview(draft, sessions, groups);
const sources = texts.map((_, i) => ({ id: `cal-e2e-${i}`, name: `calendar-${i}.ics` }));
const config = buildConfig(draft, groups, sources);
if (!config) throw new Error('no config could be built (no suggested course)');

fs.mkdirSync(path.join(outDir, 'calendars'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ ...config, rev: 1 }));
texts.forEach((text, i) => fs.writeFileSync(path.join(outDir, 'calendars', `cal-e2e-${i}.ics`), text));

// A moment in the middle of a class from the middle of the billable timetable.
const billable = billableOf(sessions, config.courses ?? []);
const mid = billable[Math.floor(billable.length / 2)];
const inClassMs = mid.startMs + Math.floor((mid.endMs - mid.startMs) / 2);

console.log(
  JSON.stringify({
    calendars: texts.length,
    sessionCount: preview.sessionCount,
    hours: preview.hours,
    pools: preview.pools.map((p) => ({ sessions: p.sessions, hours: p.hours, rate: p.rate })),
    inClassIso: new Date(inClassMs).toISOString(),
  }),
);
