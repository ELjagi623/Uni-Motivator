// Minimal hash router: `#/sessions` -> path "/sessions". No library.

import { signal } from '@preact/signals';

export type RoutePath = '/' | '/sessions' | '/settings' | '/stats';
const KNOWN: readonly RoutePath[] = ['/', '/sessions', '/settings', '/stats'];

export function parseHash(hash: string): RoutePath {
  const raw = hash.replace(/^#/, '').split('?')[0] || '/';
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return (KNOWN as readonly string[]).includes(path) ? (path as RoutePath) : '/';
}

export const route = signal<RoutePath>(parseHash(typeof location === 'undefined' ? '' : location.hash));

let listening = false;

export function startRouter(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('hashchange', () => {
    route.value = parseHash(location.hash);
  });
}

export function navigate(path: RoutePath): void {
  if (typeof location !== 'undefined') location.hash = `#${path}`;
  route.value = path;
}
