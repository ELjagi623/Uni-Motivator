// Prints the `config` document the onboarding wizard would write if both fictional calendars (the 2026 term and the
// 2027 next-year file) had been imported: three courses, 398,000 HKD per semester, per-semester billing. With the third
// argument "credit" the billing mode is credit-weighted and the first two courses get 4 and 1 credits.
//
//   tsx scripts/acceptance/p4b-make-config.ts <full-term.ics> <next-year.ics> [credit]

import fs from 'node:fs';
import { groupSessions } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';
import { buildConfig, initialDraft } from '../../src/state/onboarding';

const [fullTerm, nextYear, mode] = process.argv.slice(2);
const sessions = [...expandIcs(fs.readFileSync(fullTerm, 'utf8')), ...expandIcs(fs.readFileSync(nextYear, 'utf8'))];
const config = buildConfig({ ...initialDraft(), tuitionText: '398000' }, groupSessions(sessions), [
  { id: 'cal-a', name: 'full-term.ics' },
  { id: 'cal-b', name: 'next-year.ics' },
]);
if (!config) throw new Error('config could not be built');
if (mode === 'credit') {
  config.billingMode = 'credit';
  const byCode = (code: string) => config.courses?.find((c) => c.code === code);
  const a = byCode('MFIN7001');
  const b = byCode('MFIN7002');
  if (a) a.credits = 4;
  if (b) b.credits = 1;
}
console.log(JSON.stringify(config));
