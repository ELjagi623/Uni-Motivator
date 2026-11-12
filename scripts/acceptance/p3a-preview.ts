// Prints, as JSON, what wizard step 7 shows for a calendar file (same state code as the browser). Used by the
// acceptance script to compare the wizard preview with `npm run inspect -- --json` (an independent code path).
//
//   tsx scripts/acceptance/p3a-preview.ts <file.ics> <tuition major units> <HKD|...> <semester|year>

import fs from 'node:fs';
import { expandIcs } from '../../src/core/ics/expand';
import { groupSessions } from '../../src/core/courses';
import type { CurrencyCode } from '../../src/core/money';
import { buildPreview, initialDraft } from '../../src/state/onboarding';

const [file, tuition, currency, period] = process.argv.slice(2);
const sessions = expandIcs(fs.readFileSync(file, 'utf8'));
const draft = { ...initialDraft(), tuitionText: tuition, currency: currency as CurrencyCode, billingPeriod: period as 'semester' | 'year' };
const view = buildPreview(draft, sessions, groupSessions(sessions));
console.log(JSON.stringify({ sessionCount: view.sessionCount, hours: view.hours, rate: view.rate, average: view.average, pools: view.pools.map((p) => ({ sessions: p.sessions, hours: p.hours, rate: p.rate, average: p.average })) }));
