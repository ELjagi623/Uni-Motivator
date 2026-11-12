// Shared set-up for the page tests (session list, settings): renders the whole <App /> on a fake server at a pinned time.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { expect } from 'vitest';
import { resetCalendarState } from '../../src/state/calendars';
import { resetCurrencyState } from '../../src/state/currency';
import { resetNewYearState } from '../../src/state/newYear';
import { setPrivacy } from '../../src/state/privacy';
import { chooseSession } from '../../src/state/dashboardState';
import { flushSaves as _flush, loadAll, resetDataState } from '../../src/state/data';
import { demoActive, demoData } from '../../src/state/demoState';
import { nowOverride } from '../../src/state/now';
import { draft, initialDraft } from '../../src/state/onboarding';
import { route, startRouter, type RoutePath } from '../../src/state/router';
import { resetSessionsState } from '../../src/state/sessionsState';
import { resetSettingsState } from '../../src/state/settings';
import { resetReminderState, startReminders } from '../../src/state/reminders';
import { resetShareState } from '../../src/state/share';
import { slackUi, startSlackWatcher } from '../../src/state/slack';
import { startTitleUpdates } from '../../src/state/title';
import { App } from '../../src/ui/App';
import { installFakeServer, type FakeServer } from '../state/fake-server';
import { NOWS, fixtureConfig, fullTermText } from '../state/fixture-app';

export const flushSaves = _flush;

export interface Harness {
  host: HTMLDivElement;
  server: FakeServer;
  $: <T extends Element = HTMLElement>(sel: string) => T | null;
  $$: <T extends Element = HTMLElement>(sel: string) => T[];
  field: (name: string) => string | null;
  settle: () => Promise<void>;
  click: (sel: string) => Promise<void>;
  type: (sel: string, value: string) => Promise<void>;
  key: (sel: string, key: string) => Promise<void>;
}

let current: Harness | null = null;
let stops: Array<() => void> = [];

export function resetHarnessState(): void {
  resetDataState();
  resetCalendarState();
  resetSessionsState();
  resetSettingsState();
  resetReminderState();
  resetShareState();
  resetCurrencyState();
  resetNewYearState();
  setPrivacy(false);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-privacy');
  draft.value = initialDraft();
  demoActive.value = false;
  demoData.value = null;
  slackUi.value = null;
  chooseSession(null);
  nowOverride.value = null;
  route.value = '/';
  document.title = '';
}

export function teardown(): void {
  for (const stop of stops) stop();
  stops = [];
  if (current) {
    render(null, current.host);
    current.host.remove();
    current.server.restore();
    current = null;
  }
  nowOverride.value = null;
  route.value = '/';
}

export interface BootOptions {
  path?: RoutePath;
  nowMs?: number;
  docs?: Parameters<typeof installFakeServer>[0];
  texts?: string[];
  configOverride?: ReturnType<typeof fixtureConfig>;
}

export async function boot(options: BootOptions = {}): Promise<Harness> {
  teardown();
  resetHarnessState();
  const config = options.configOverride ?? fixtureConfig();
  const texts = options.texts ?? [fullTermText];
  const server = installFakeServer({ config: config as unknown as Record<string, unknown>, ...options.docs }, texts.map((text, i) => ({ id: i === 0 ? 'cal-fixture' : `cal-${i}`, text })));
  const host = document.createElement('div');
  document.body.appendChild(host);
  await loadAll();
  nowOverride.value = options.nowMs ?? NOWS.inClass;
  startRouter(); // anchors in the navigation change location.hash
  location.hash = `#${options.path ?? '/'}`;
  route.value = options.path ?? '/';
  stops = [startSlackWatcher(), startTitleUpdates(), startReminders()];

  const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  const h: Harness = {
    host,
    server,
    $,
    $$: <T extends Element = HTMLElement>(sel: string) => Array.from(host.querySelectorAll<T>(sel)),
    field: (name) => $(`[data-field="${name}"]`)?.textContent ?? null,
    settle,
    click: async (sel) => {
      const el = $<HTMLElement>(sel);
      expect(el, sel).not.toBeNull();
      await act(async () => {
        el!.click();
      });
      await settle();
    },
    type: async (sel, value) => {
      const el = $<HTMLInputElement>(sel);
      expect(el, sel).not.toBeNull();
      await act(async () => {
        el!.value = value;
        el!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle();
    },
    key: async (sel, key) => {
      const el = $<HTMLElement>(sel);
      expect(el, sel).not.toBeNull();
      await act(async () => {
        el!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
      await settle();
    },
  };
  current = h;
  await act(async () => {
    render(<App />, host);
  });
  await settle();
  return h;
}
