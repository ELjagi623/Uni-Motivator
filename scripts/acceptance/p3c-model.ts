// What the session-list page shows for a data folder at one instant, computed by the UI state layer
// (`buildSessionsModel`): the three summary figures and the marks on the rows of the week of `now`.
//
//   tsx scripts/acceptance/p3c-model.ts <data dir> <TZ> <ISO-8601>

import fs from 'node:fs';
import path from 'node:path';
import { buildPools } from '../../src/core/billing';
import { expandIcs, mergeSessions } from '../../src/core/ics/expand';
import type { Session } from '../../src/core/types';
import type { AppConfig } from '../../src/state/config';
import { buildSessionsModel } from '../../src/state/sessions';
import { billableOf, billingConfigOf } from '../../src/state/derived';

const [dataDir, tz, iso] = process.argv.slice(2);
process.env.TZ = tz;

const readJson = (name: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const config = readJson('config.json') as unknown as AppConfig;
const marksDoc = readJson('marks.json');
const slacksDoc = readJson('slacks.json');
const calDir = path.join(dataDir, 'calendars');
const files = fs.readdirSync(calDir).filter((f) => f.endsWith('.ics')).sort();
const sessions: Session[] = mergeSessions(files.map((f) => expandIcs(fs.readFileSync(path.join(calDir, f), 'utf8'))));
const courses = config.courses ?? [];
const billable = billableOf(sessions, courses);
const pools = buildPools(billable, billingConfigOf(config));
const marks = (marksDoc.marks && typeof marksDoc.marks === 'object' ? marksDoc.marks : {}) as Record<string, { status?: 'cancelled' | 'skipped' }>;
const slacks = (Array.isArray(slacksDoc.records) ? slacksDoc.records : []) as Array<{ id: string; sessionId: string; startMs: number; endMs?: number }>;
const inputs = { sessions: billable, courses, pools, marks, slacks, currency: config.currency ?? ('HKD' as const) };

const nowMs = Date.parse(iso);
const model = buildSessionsModel(inputs, nowMs, null);
console.log(
  JSON.stringify({
    iso,
    weekLabel: model.weekLabel,
    summary: {
      'cancelled-amount': model.summary.cancelledText,
      'skipped-amount': model.summary.skippedText,
      'attendance-rate': model.summary.attendanceText,
    },
    rows: model.rows.map((r) => ({ id: r.id, mark: r.mark, phase: r.phase })),
  }),
);
