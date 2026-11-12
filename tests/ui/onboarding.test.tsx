// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAll, resetDataState, notice } from '../../src/state/data';
import { importFiles, resetCalendarState } from '../../src/state/calendars';
import { draft, initialDraft, updateDraft } from '../../src/state/onboarding';
import { App } from '../../src/ui/App';
import { installFakeServer, type FakeServer } from '../state/fake-server';

const fullTerm = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'full-term.ics'), 'utf8');

let server: FakeServer;
let host: HTMLDivElement;

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = (sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel));
const text = () => host.textContent ?? '';

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(sel: string): Promise<void> {
  const el = $<HTMLButtonElement>(sel);
  expect(el, sel).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

async function type(sel: string, value: string): Promise<void> {
  const el = $<HTMLInputElement>(sel);
  expect(el, sel).not.toBeNull();
  await act(async () => {
    el!.value = value;
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    render(<App />, host);
  });
  await flush();
}

beforeEach(async () => {
  resetDataState();
  resetCalendarState();
  draft.value = initialDraft();
  server = installFakeServer();
  host = document.createElement('div');
  document.body.appendChild(host);
  await loadAll();
});

afterEach(() => {
  render(null, host);
  host.remove();
  server.restore();
});

describe('App shell', () => {
  it('shows the wizard at step 1 until onboarding is done, then the shell', async () => {
    await mount();
    expect($('#onboarding')).not.toBeNull();
    expect($('#step-counter')?.textContent).toBe('1 / 7');
    expect($('#shell')).toBeNull();
  });

  it('goes straight to the main shell when the config says onboarding is done', async () => {
    render(null, host);
    server.restore();
    server = installFakeServer({ config: { onboardingDone: true } });
    await loadAll();
    await mount();
    expect($('#shell')).not.toBeNull();
    expect($('#onboarding')).toBeNull();
  });

  it('shows the sync notice and lets the user dismiss it', async () => {
    await mount();
    await act(async () => {
      notice.value = '数据在别的标签页被改过，已刷新';
    });
    expect(text()).toContain('数据在别的标签页被改过，已刷新');
    const dismiss = $$('.notice button')[0];
    await act(async () => dismiss.click());
    expect($('.notice')).toBeNull();
  });
});

describe('Onboarding wizard', () => {
  it('walks through all seven steps and writes the config on finish', async () => {
    await mount();
    expect($('#prev-btn')?.hasAttribute('disabled')).toBe(true);

    // 1 region (southern fills its preset dates on step 4), 2 period
    await act(async () => {
      $$('input[name="region"]')[1].click();
    });
    await click('#next-btn');
    expect($('#step-counter')?.textContent).toBe('2 / 7');
    await click('#next-btn');

    // 3 currency and tuition: next is disabled until the tuition is valid
    expect($('#step-counter')?.textContent).toBe('3 / 7');
    expect($('#next-btn')?.hasAttribute('disabled')).toBe(true);
    await type('#tuition-input', '0');
    expect($('#next-btn')?.hasAttribute('disabled')).toBe(true);
    await type('#tuition-input', '398000');
    expect($('#next-btn')?.hasAttribute('disabled')).toBe(false);
    expect(text()).toContain('HK$398,000.00');
    await act(async () => {
      $$('input[name="currency"]')[2].click(); // USD
    });
    expect(text()).toContain('US$398,000.00');
    await act(async () => {
      $$('input[name="currency"]')[0].click(); // back to HKD
    });
    await click('#next-btn');

    // 4 dates (southern preset), invalid input blocks
    expect(($('#year-start-input') as HTMLInputElement).value).toBe('01-01');
    expect(($('#split-date-input') as HTMLInputElement).value).toBe('07-01');
    await type('#split-date-input', '99-99');
    expect($('#next-btn')?.hasAttribute('disabled')).toBe(true);
    await type('#year-start-input', '08-01');
    await type('#split-date-input', '12-25');
    await click('#next-btn');

    // 5 import: next stays disabled until a calendar is imported
    expect($('#step-counter')?.textContent).toBe('5 / 7');
    expect($('#next-btn')?.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      await importFiles([{ name: 'full-term.ics', data: new Uint8Array(Buffer.from(fullTerm, 'utf8')) }]);
    });
    expect($('#calendar-list')?.textContent).toContain('full-term.ics');
    expect($('#calendar-list')?.textContent).toContain('58');
    await click('#next-btn');

    // 6 recognition: two suggested groups, footer shows the live preview, unticking all blocks next
    expect($$('.course-row')).toHaveLength(2);
    expect($('#footer-preview')?.textContent).toContain('58');
    expect($('#footer-preview')?.textContent).toContain('174.0');
    const boxes = $$('.course-row input[type="checkbox"]') as HTMLInputElement[];
    expect(boxes.every((b) => b.checked)).toBe(true);
    await act(async () => boxes[0].click());
    expect($('#footer-preview')?.textContent).not.toContain('58 ');
    await act(async () => boxes[1].click());
    expect($('#next-btn')?.hasAttribute('disabled')).toBe(true);
    expect(text()).toContain('至少勾选一项才能继续');
    await act(async () => boxes[0].click());
    await act(async () => boxes[1].click());
    await click('#next-btn');

    // 7 preview and finish
    expect($('#step-counter')?.textContent).toBe('7 / 7');
    expect($('#preview-rate')?.textContent).toBe('HK$1.2708');
    expect($('#preview')?.textContent).toContain('58');
    expect($('#split-checks')?.textContent).toContain('没问题');
    expect($$('#preview-pools li')).toHaveLength(2);
    expect($('#finish-btn')?.hasAttribute('disabled')).toBe(false);
    await click('#finish-btn');
    await flush();

    expect($('#shell')).not.toBeNull();
    const saved = server.docs.config;
    expect(saved).toMatchObject({ onboardingDone: true, currency: 'HKD', region: 'southern', tuition: { defaultMinor: 39800000 }, academic: { yearStart: '08-01', splitDate: '12-25', billingPeriod: 'semester' } });
  });

  it('"finish" is disabled when the tuition is empty, and step 7 sends the user back to step 3', async () => {
    await importFiles([{ name: 'full-term.ics', data: new Uint8Array(Buffer.from(fullTerm, 'utf8')) }]);
    updateDraft({ step: 7, tuitionText: '' });
    await mount();
    expect($('#finish-btn')?.hasAttribute('disabled')).toBe(true);
    expect($('#preview')).toBeNull();
    const back = $$('.step-body button')[0];
    await act(async () => back.click());
    expect($('#step-counter')?.textContent).toBe('3 / 7');
  });

  it('step 7 sends the user back to the recognition page when nothing is ticked', async () => {
    await importFiles([{ name: 'full-term.ics', data: new Uint8Array(Buffer.from(fullTerm, 'utf8')) }]);
    const keys = Object.fromEntries(['MFIN7001', 'MFIN7002'].map((c) => [`code:${c}`, false]));
    updateDraft({ step: 7, tuitionText: '398000', selection: keys });
    await mount();
    expect($('#finish-btn')?.hasAttribute('disabled')).toBe(true);
    const back = $$('.step-body button')[0];
    await act(async () => back.click());
    expect($('#step-counter')?.textContent).toBe('6 / 7');
  });

  it('every control has an accessible name and the step bar exposes the current step', async () => {
    updateDraft({ step: 3 });
    await mount();
    for (const el of $$('input:not([type="radio"]), button')) {
      const name = el.getAttribute('aria-label') || el.textContent?.trim() || (el.id && host.querySelector(`label[for="${el.id}"]`)?.textContent?.trim());
      expect(name, el.outerHTML).toBeTruthy();
    }
    expect($$('.steps li')).toHaveLength(7);
    expect($('.steps li[aria-current="step"]')).not.toBeNull();
    expect($$('.steps li.done')).toHaveLength(3);
  });

  it('labels the tuition field by billing period', async () => {
    updateDraft({ step: 3, billingPeriod: 'year' });
    await mount();
    expect(text()).toContain('一学年学费');
    updateDraft({ billingPeriod: 'semester' });
    await flush();
    expect(text()).toContain('每学期学费');
  });
});
