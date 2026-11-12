// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePrivacyKey, installPrivacyShortcut, isTypingTarget, privacyOn, setPrivacy, togglePrivacy } from '../../src/state/privacy';

const root = path.resolve(__dirname, '..', '..');

function press(target: EventTarget, init: KeyboardEventInit = { key: 'b' }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

let stop: () => void;

beforeEach(() => {
  setPrivacy(false);
  stop = installPrivacyShortcut(document);
});
afterEach(() => {
  stop();
  setPrivacy(false);
  document.body.innerHTML = '';
});

describe('privacy mode: the key B', () => {
  it('B puts data-privacy="on" on the root element, a second B takes it off again', () => {
    expect(document.documentElement.hasAttribute('data-privacy')).toBe(false);
    press(document.body);
    expect(document.documentElement.getAttribute('data-privacy')).toBe('on');
    expect(privacyOn.value).toBe(true);
    press(document.body, { key: 'B' });
    expect(document.documentElement.hasAttribute('data-privacy')).toBe(false);
    expect(privacyOn.value).toBe(false);
  });

  it('typing a b in an input, a textarea, a select or an editable element does not trigger it', () => {
    document.body.innerHTML = '<input id="i" /><textarea id="t"></textarea><select id="s"><option>x</option></select><div id="c" contenteditable="true"></div><button id="b">btn</button>';
    for (const id of ['i', 't', 's', 'c']) {
      press(document.getElementById(id)!);
      expect(document.documentElement.hasAttribute('data-privacy'), id).toBe(false);
    }
    // a plain button is not a typing target: the key works there
    press(document.getElementById('b')!);
    expect(document.documentElement.getAttribute('data-privacy')).toBe('on');
  });

  it('only a plain B counts: not with Ctrl / Alt / Meta, not while holding the key down, not while composing text', () => {
    press(document.body, { key: 'b', ctrlKey: true });
    press(document.body, { key: 'b', metaKey: true });
    press(document.body, { key: 'b', altKey: true });
    press(document.body, { key: 'b', repeat: true });
    press(document.body, { key: 'x' });
    expect(privacyOn.value).toBe(false);
    const composing = new KeyboardEvent('keydown', { key: 'b', bubbles: true, isComposing: true });
    expect(handlePrivacyKey(composing)).toBe(false);
  });

  it('is not saved anywhere: nothing is written to storage, and a fresh load starts with the mode off', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    togglePrivacy();
    expect(setItem).not.toHaveBeenCalled();
    expect(Object.keys(localStorage).filter((k) => /privacy/i.test(k))).toEqual([]);
    // "reload the app": a freshly imported module has its initial state
    vi.resetModules();
    const fresh = await import('../../src/state/privacy');
    expect(fresh.privacyOn.value).toBe(false);
    setItem.mockRestore();
  });

  it('recognises typing targets', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('privacy mode: the blur rule', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'styles', 'components.css'), 'utf8');

  it('the stylesheet blurs every .money element while data-privacy is on (the blur is at least 8px)', () => {
    const rule = /\[data-privacy='on'\]\s*\.money\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'no [data-privacy=on] .money rule').not.toBeNull();
    expect(rule![1]).toMatch(/filter:\s*blur\(max\(8px,/);
  });
});
