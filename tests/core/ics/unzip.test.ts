import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readCalendarFile, unzipIcs } from '../../../src/core/ics/unzip';
import { readFixture } from '../helpers';
import { expandIcs } from '../../../src/core/ics/expand';

function makeZip(): Uint8Array {
  return zipSync({
    'a/term1.ics': strToU8(readFixture('weekly.ics')),
    'term2.ICS': strToU8(readFixture('exdate.ics')),
    'notes.txt': strToU8('not a calendar'),
    '__MACOSX/a/._term1.ics': strToU8('resource fork'),
    'a/._hidden.ics': strToU8('resource fork'),
  });
}

describe('unzipIcs', () => {
  it('extracts only .ics entries (case-insensitive) and skips macOS resource forks', () => {
    const files = unzipIcs(makeZip());
    expect(files.map((f) => f.name)).toEqual(['a/term1.ics', 'term2.ICS']);
    expect(files[0].text.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });

  it('produces text that the parser expands (zip -> sessions)', () => {
    const files = unzipIcs(makeZip());
    const counts = files.map((f) => expandIcs(f.text).length);
    expect(counts).toEqual([4, 5]);
  });

  it('strips a UTF-8 byte order mark', () => {
    const zip = zipSync({ 'bom.ics': new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('BEGIN:VCALENDAR\r\nEND:VCALENDAR')]) });
    expect(unzipIcs(zip)[0].text.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });

  it('returns an empty list for a zip without calendars', () => {
    expect(unzipIcs(zipSync({ 'readme.txt': strToU8('x') }))).toEqual([]);
  });
});

describe('readCalendarFile', () => {
  it('unzips .zip files and decodes plain .ics files as UTF-8', () => {
    expect(readCalendarFile('x.ZIP', makeZip())).toHaveLength(2);
    const plain = readCalendarFile('my.ics', strToU8('BEGIN:VCALENDAR\r\nSUMMARY:课程\r\nEND:VCALENDAR'));
    expect(plain).toEqual([{ name: 'my.ics', text: 'BEGIN:VCALENDAR\r\nSUMMARY:课程\r\nEND:VCALENDAR' }]);
  });
});
