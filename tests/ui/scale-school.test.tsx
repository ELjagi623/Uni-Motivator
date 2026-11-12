// @vitest-environment happy-dom
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../src/state/data';
import { applyScale, clampScale, DEFAULT_SCALE, readStoredScale, SCALE_STORAGE_KEY } from '../../src/state/scale';
import { boot, flushSaves, teardown } from './harness';

afterEach(() => {
  teardown();
  document.documentElement.style.removeProperty('--ui-scale');
  try {
    localStorage.removeItem(SCALE_STORAGE_KEY);
  } catch {
    /* no storage */
  }
});

describe('interface size', () => {
  it('keeps the percentage inside the allowed range', () => {
    expect(DEFAULT_SCALE).toBe(120);
    expect(clampScale(100)).toBe(100);
    expect(clampScale(10)).toBe(70);
    expect(clampScale(900)).toBe(200);
    expect(clampScale(Number.NaN)).toBe(120);
    expect(clampScale('150')).toBe(120);
  });

  it('applyScale sets --ui-scale on the root element, and the default size removes it (the CSS fallback is 1.2)', () => {
    applyScale(125);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
    applyScale(120);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
  });

  it('the settings slider applies the size when released, saves it in the config and remembers it for the next start', async () => {
    const h = await boot({ path: '/settings' });
    const slider = h.$<HTMLInputElement>('#settings-scale')!;
    expect(slider.value).toBe('120');
    expect(h.$<HTMLButtonElement>('#scale-reset')!.disabled).toBe(true);

    await act(async () => {
      slider.value = '150';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await h.settle();
    expect(h.field('scale-value')).toBe('150%'); // the number follows the handle...
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe(''); // ...the page is not resized under it

    await act(async () => {
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await h.settle();
    await flushSaves();
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.5');
    expect((config.value as { uiScale?: number }).uiScale).toBe(150);
    expect(h.server.puts('config').at(-1)?.json).toMatchObject({ doc: { uiScale: 150 } });
    expect(readStoredScale()).toBe(150);

    await h.click('#scale-reset');
    await flushSaves();
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
    expect((config.value as { uiScale?: number }).uiScale).toBe(120);
    expect(readStoredScale()).toBeNull();
  });
});

describe('renaming the school', () => {
  it('the settings have a school-name field; typing saves it and the dashboard title follows', async () => {
    const h = await boot({ path: '/settings' });
    await h.type('#settings-school', '  Harbour University ');
    await flushSaves();
    expect((config.value as { school?: string }).school).toBe('  Harbour University ');
    expect(h.server.puts('config').at(-1)?.json).toMatchObject({ doc: { school: '  Harbour University ' } });
    await h.click('#settings-back');
    expect(h.$('.topbar__title')?.textContent).toContain('Harbour University');
  });

  it('an empty name falls back to the app title', async () => {
    const h = await boot({ path: '/settings' });
    await h.type('#settings-school', 'X');
    await h.type('#settings-school', '');
    await h.click('#settings-back');
    expect(h.$('.topbar__title')?.textContent).toContain('学费计价器');
  });
});
