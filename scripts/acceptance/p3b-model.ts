// Prints the numbers the dashboard shows (computed by the UI state layer: buildDashboardModel + liveAt, formatted
// exactly as the components format them) for a data folder at several instants. The acceptance script compares them
// with `npm run query` (which uses core directly).
//
//   tsx scripts/acceptance/p3b-model.ts <data dir> <TZ> <ISO-8601>...

import fs from 'node:fs';
import path from 'node:path';
import { buildPools } from '../../src/core/billing';
import { expandIcs, mergeSessions } from '../../src/core/ics/expand';
import { formatAmountMinor, formatMinor } from '../../src/core/money';
import type { Session } from '../../src/core/types';
import type { AppConfig } from '../../src/state/config';
import { buildDashboardModel, durationText, liveAt, percentText } from '../../src/state/dashboard';
import { billableOf, billingConfigOf } from '../../src/state/derived';

const [dataDir, tz, ...nows] = process.argv.slice(2);
process.env.TZ = tz;

const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as AppConfig;
const calDir = path.join(dataDir, 'calendars');
const files = fs.readdirSync(calDir).filter((f) => f.endsWith('.ics')).sort();
const sessions: Session[] = mergeSessions(files.map((f) => expandIcs(fs.readFileSync(path.join(calDir, f), 'utf8'))));
const courses = config.courses ?? [];
const billable = billableOf(sessions, courses);
const pools = buildPools(billable, billingConfigOf(config));
const inputs = { sessions: billable, courses, pools, marks: {}, slacks: [], currency: config.currency ?? ('HKD' as const) };

const results = nows.map((iso) => {
  const nowMs = Date.parse(iso);
  const model = buildDashboardModel(inputs, nowMs);
  const view = model.active[0] ?? null;
  const anchor = view?.id ?? model.next?.id ?? model.prev?.id ?? null;
  const live = liveAt(model, anchor, nowMs);
  const fields: Record<string, string> = {
    'pool-tuition': formatAmountMinor(live.poolTuitionMinor),
    'pool-consumed': formatAmountMinor(live.poolConsumedMinor),
    'pool-remaining': formatAmountMinor(live.poolRemainingMinor),
    'pool-percent': percentText(live.poolProgress),
  };
  if (view) {
    fields['session-consumed'] = formatAmountMinor(live.sessionConsumedMinor);
    fields['session-remaining'] = formatAmountMinor(live.sessionRemainingMinor);
    fields['session-cost'] = formatMinor(view.costMinor, model.currency);
    fields['rate-per-sec'] = view.rateText;
    fields.elapsed = durationText(live.elapsedSec);
    fields['time-left'] = durationText(live.remainingSec);
    fields['session-index'] = view.ordinal ? `${view.ordinal.index} / ${view.ordinal.total}` : '';
  }
  if (model.kind === 'break' && model.next) fields.countdown = durationText(liveAt(model, model.next.id, nowMs).countdownSec);
  return { iso, status: model.kind, daysUntilTerm: model.daysUntilTerm, fields };
});
console.log(JSON.stringify(results));
