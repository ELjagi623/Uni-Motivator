import { describe, expect, it } from 'vitest';
import {
  assignCourses,
  COURSE_COLORS,
  courseFromGroup,
  extractCourseCode,
  groupSessions,
  isExcludedTitle,
  matchCourse,
  normalizeTitle,
  sessionsOfCourses,
} from '../../src/core/courses';
import type { Session } from '../../src/core/types';
import { fixtureSessions } from './helpers';

const groups = groupSessions(fixtureSessions('lecture-tutorial.ics'));
const byKey = (key: string) => groups.find((g) => g.key === key);

describe('extractCourseCode', () => {
  it('finds codes with or without a space and normalises them', () => {
    expect(extractCourseCode('MFIN7001 Corporate Finance')).toBe('MFIN7001');
    expect(extractCourseCode('COMP 3230 Lab')).toBe('COMP3230');
    expect(extractCourseCode('Intro to MATH1013A (Tue)')).toBe('MATH1013A');
    expect(extractCourseCode('CS101')).toBe('CS101');
  });
  it('does not mistake ordinary words for codes', () => {
    expect(extractCourseCode('Room 1234')).toBeNull();
    expect(extractCourseCode('comp3230 lowercase')).toBeNull();
    expect(extractCourseCode('Academic Writing')).toBeNull();
    expect(extractCourseCode('A1')).toBeNull();
  });
});

describe('normalizeTitle / isExcludedTitle', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeTitle('  Academic   Writing \t')).toBe('Academic Writing');
  });
  it('flags non-class keywords', () => {
    for (const t of ['Final Exam', 'Quiz 2', 'Assignment due', 'Public Holiday', 'Reading Week', 'Office Hour', 'Office Hours', '期末考试', '清明假期', 'Deadline: report']) {
      expect(isExcludedTitle(t), t).toBe(true);
    }
    for (const t of ['COMP3230 Lecture', 'Duelling Workshop', 'Examples class', 'Studio']) {
      expect(isExcludedTitle(t), t).toBe(false);
    }
  });
});

describe('groupSessions on the Lecture + Tutorial fixture', () => {
  it('puts Lecture, Tutorial and "COMP 3230 Lab" into one group keyed by the course code', () => {
    const g = byKey('code:COMP3230');
    expect(g).toBeDefined();
    expect(g!.code).toBe('COMP3230');
    expect(g!.count).toBe(16); // 6 + 6 + 4
    expect(g!.totalSeconds).toBe((6 * 2 + 6 * 1 + 4 * 2) * 3600);
    expect(g!.titles).toEqual(['COMP 3230 Lab', 'COMP3230 Lecture', 'COMP3230 Tutorial']);
    expect(g!.suggested).toBe(true);
    expect(g!.reason).toBe('ok');
    expect(g!.name).toBe('COMP3230');
  });

  it('suggests a title-only recurring class and groups by normalised, case-insensitive title', () => {
    const g = byKey('title:academic writing');
    expect(g).toMatchObject({ code: null, count: 5, suggested: true, name: 'Academic Writing' });
  });

  it('does not suggest exam / holiday / office-hour groups, and keeps the exam out of the course it mentions', () => {
    expect(byKey('x:midterm exam comp3230')).toMatchObject({ suggested: false, reason: 'excluded-keyword', count: 1 });
    expect(byKey('x:public holiday')).toMatchObject({ suggested: false, reason: 'excluded-keyword' });
    expect(byKey('x:econ office hour')).toMatchObject({ suggested: false, reason: 'excluded-keyword', count: 10 });
  });

  it('does not suggest groups with fewer than 4 sessions or implausible durations', () => {
    expect(byKey('title:guest talk')).toMatchObject({ suggested: false, reason: 'too-few' });
    expect(byKey('title:daily standup')).toMatchObject({ suggested: false, reason: 'bad-duration', count: 8 });
  });

  it('lists suggested groups first, biggest total time first', () => {
    const order = groups.map((g) => g.suggested);
    expect(order).toEqual([...order].sort((a, b) => Number(b) - Number(a)));
    expect(groups[0].key).toBe('code:COMP3230');
  });

  it('counts every session exactly once', () => {
    const total = groups.reduce((a, g) => a + g.count, 0);
    expect(total).toBe(fixtureSessions('lecture-tutorial.ics').length);
    const ids = groups.flatMap((g) => g.sessionIds);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('courses and re-import matching', () => {
  const sessions = fixtureSessions('lecture-tutorial.ics');
  const comp = courseFromGroup(byKey('code:COMP3230')!, { credits: 3, colorIndex: 0 });
  const writing = courseFromGroup(byKey('title:academic writing')!, { colorIndex: 1 });

  it('builds courses with a stable id and a match section', () => {
    expect(comp).toMatchObject({ code: 'COMP3230', credits: 3, match: { codes: ['COMP3230'], titles: [] } });
    expect(writing).toMatchObject({ code: null, credits: null, match: { codes: [], titles: ['academic writing'] } });
    expect(courseFromGroup(byKey('code:COMP3230')!).id).toBe(comp.id);
    expect(comp.id).not.toBe(writing.id);
    expect(comp.color).toBe(COURSE_COLORS[0]);
    expect(courseFromGroup(byKey('code:COMP3230')!, { colorIndex: COURSE_COLORS.length + 2 }).color).toBe(COURSE_COLORS[2]);
    expect(courseFromGroup(byKey('code:COMP3230')!, { colorIndex: -1 }).color).toBe(COURSE_COLORS[COURSE_COLORS.length - 1]);
  });

  it('re-attaches sessions after a re-import by code and by title', () => {
    expect(matchCourse('COMP3230 Lecture', [comp, writing])?.id).toBe(comp.id);
    expect(matchCourse('COMP 3230 Tutorial 2', [comp, writing])?.id).toBe(comp.id);
    expect(matchCourse('  academic   WRITING ', [comp, writing])?.id).toBe(writing.id);
    expect(matchCourse('Something else', [comp, writing])).toBeNull();
  });

  it('never re-attaches exams or holidays to a course just because they mention its code', () => {
    expect(matchCourse('Midterm Exam COMP3230', [comp, writing])).toBeNull();
    expect(matchCourse('COMP3230 Quiz', [comp])).toBeNull();
  });

  it('assigns courses to sessions and filters the billable sessions', () => {
    const assigned = assignCourses(sessions, [comp, writing]);
    expect(assigned.size).toBe(16 + 5);
    const billable = sessionsOfCourses(sessions, [comp, writing]);
    expect(billable).toHaveLength(21);
    expect(billable.every((s) => assigned.has(s.id))).toBe(true);
    expect(sessionsOfCourses(sessions, [])).toEqual([]);
  });

  it('handles an empty session list', () => {
    expect(groupSessions([])).toEqual([]);
  });

  it('names a group after its code when only the generic suffix remains, and keeps unusual titles as they are', () => {
    const mk = (title: string, i: number): Session => ({ id: `${title}${i}`, uid: title, title, location: '', startMs: 1e12 + i * 7 * 86_400_000, endMs: 1e12 + i * 7 * 86_400_000 + 2 * 3_600_000 });
    const lec = groupSessions([0, 1, 2, 3].map((i) => mk('Seminar', i)))[0];
    expect(lec.name).toBe('Seminar'); // nothing but the suffix: keep it rather than an empty name
    const chinese = groupSessions([0, 1, 2, 3].map((i) => mk('金融学 讲座', i)))[0];
    expect(chinese.name).toBe('金融学');
  });
});
