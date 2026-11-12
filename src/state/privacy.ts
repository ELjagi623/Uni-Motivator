// Privacy ("peek-proof") mode: the key B blurs every money amount (elements with the `money` class), so the screen can
// be left open in a lecture hall. It is never saved: every time the page opens it starts off.
//
// The blur itself is CSS: `:root[data-privacy='on'] .money { filter: blur(...) }` (src/styles/components.css). This
// file only keeps the on / off state, mirrors it into the `data-privacy` attribute of the root element and listens
// for the key.

import { effect, signal } from '@preact/signals';

export const privacyOn = signal(false);

export function setPrivacy(on: boolean): void {
  privacyOn.value = on;
}

export function togglePrivacy(): void {
  privacyOn.value = !privacyOn.peek();
}

/** True when the event comes from somewhere the user is typing: the shortcut must not fire there. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable === true) return true;
  const editable = el.getAttribute?.('contenteditable');
  return editable === '' || editable === 'true' || editable === 'plaintext-only';
}

/** Handle one keydown: toggles on a plain B (not while typing, not with Ctrl / Alt / Meta, not while composing text). */
export function handlePrivacyKey(event: KeyboardEvent): boolean {
  if (event.key !== 'b' && event.key !== 'B') return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return false;
  if (event.defaultPrevented || isTypingTarget(event.target)) return false;
  togglePrivacy();
  return true;
}

/** Listen for the key and keep `data-privacy` on the root element in line with the state. Returns the stop function. */
export function installPrivacyShortcut(doc: Document = document): () => void {
  const onKey = (event: KeyboardEvent) => {
    handlePrivacyKey(event);
  };
  doc.addEventListener('keydown', onKey);
  const stopEffect = effect(() => {
    const root = doc.documentElement;
    if (privacyOn.value) root.setAttribute('data-privacy', 'on');
    else root.removeAttribute('data-privacy');
  });
  return () => {
    doc.removeEventListener('keydown', onKey);
    stopEffect();
    doc.documentElement.removeAttribute('data-privacy');
  };
}
