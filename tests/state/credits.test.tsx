// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { groupSessions } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';
import { MAX_CREDITS, parseCreditsText } from '../../src/state/credits';
import { creditsInvalid, selectedCourses, initialDraft } from '../../src/state/onboarding';
import { CourseList } from '../../src/ui/pages/CourseRecognition';
import { fullTermText } from './fixture-app';

describe('credits typed by the user', () => {
  it('empty = not set; a number greater than zero is a credit value; everything else is invalid', () => {
    expect(parseCreditsText('')).toBeNull();
    expect(parseCreditsText('  ')).toBeNull();
    expect(parseCreditsText('3')).toBe(3);
    expect(parseCreditsText('2.5')).toBe(2.5);
    expect(parseCreditsText('.5')).toBe(0.5);
    expect(parseCreditsText(String(MAX_CREDITS))).toBe(MAX_CREDITS);
    for (const bad of ['0', '0.0', '-1', 'abc', '1e2', '1,5', String(MAX_CREDITS + 1), '--2', '3 4']) expect(parseCreditsText(bad), bad).toBeUndefined();
  });

  it('the wizard flags bad credits and keeps them out of the course (a bad value never becomes a credit)', () => {
    expect(creditsInvalid('0')).toBe(true);
    expect(creditsInvalid('x')).toBe(true);
    expect(creditsInvalid('')).toBe(false);
    expect(creditsInvalid(undefined)).toBe(false);
    expect(creditsInvalid('3')).toBe(false);
    const groups = groupSessions(expandIcs(fullTermText));
    const key = groups[0].key;
    const courses = selectedCourses({ ...initialDraft(), credits: { [key]: '4', [groups[1].key]: '-2' } }, groups);
    expect(courses.map((c) => c.credits)).toEqual([4, null]);
  });

  it('the recognition list shows an error under a credits field that is not a positive number, and lets a good one through', async () => {
    const groups = groupSessions(expandIcs(fullTermText));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onCredits = vi.fn();
    const view = (credits: string) => (
      <CourseList groups={groups} isOn={() => true} nameOf={(g) => g.name} creditsOf={() => credits} onSelect={() => undefined} onName={() => undefined} onCredits={onCredits} idPrefix="x" />
    );
    await act(async () => render(view('0'), host));
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(groups.length);
    expect(host.querySelector('input.credits')?.getAttribute('aria-invalid')).toBe('true');
    await act(async () => render(view('3'), host));
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
    const input = host.querySelector<HTMLInputElement>('input.credits')!;
    await act(async () => {
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onCredits).toHaveBeenCalledWith(groups[0].key, '2');
    render(null, host);
    host.remove();
  });
});
