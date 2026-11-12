// Prints the `config` document the onboarding wizard would write for a calendar file (tuition 398000 HKD, per
// semester, all suggested courses ticked). The acceptance script PUTs it to a temporary data folder.
//
//   tsx scripts/acceptance/p3b-make-config.ts <file.ics> <calendar id>

import fs from 'node:fs';
import { groupSessions } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';
import { buildConfig, initialDraft } from '../../src/state/onboarding';

const [file, calendarId] = process.argv.slice(2);
const sessions = expandIcs(fs.readFileSync(file, 'utf8'));
const config = buildConfig({ ...initialDraft(), tuitionText: '398000' }, groupSessions(sessions), [{ id: calendarId, name: 'full-term.ics' }]);
console.log(JSON.stringify(config));
