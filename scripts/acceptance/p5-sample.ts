// Prints {sessions, courses} for examples/sample-calendar.ics (counts only): the acceptance script checks the sample
// timetable has at least 10 classes that the core parser understands.
import fs from 'node:fs';
import { groupSessions } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';

const sessions = expandIcs(fs.readFileSync('examples/sample-calendar.ics', 'utf8'));
const suggested = groupSessions(sessions).filter((g) => g.suggested).length;
console.log(JSON.stringify({ sessions: sessions.length, suggestedCourses: suggested }));
