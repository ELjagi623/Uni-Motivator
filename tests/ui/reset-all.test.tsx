// @vitest-environment happy-dom
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmReset, emptyBackupText, resetError } from '../../src/state/backup';
import { boot, teardown } from './harness';

afterEach(() => {
  teardown();
  localStorage.clear();
  sessionStorage.clear();
});

describe('reset all data (settings)', () => {
  it('is the last card of the settings; the button asks first, and cancelling changes nothing', async () => {
    const h = await boot({ path: '/settings' });
    const cards = h.$$('.settings-grid > section');
    expect(cards.at(-1)?.id).toBe('card-reset');
    expect(h.$('#reset-dialog')).toBeNull();

    await h.click('#reset-all');
    const dialog = h.$('#reset-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('data/backups');
    expect(document.activeElement?.id).toBe('reset-dialog-cancel'); // focus starts on the safe choice

    await h.click('#reset-dialog-cancel');
    expect(h.$('#reset-dialog')).toBeNull();
    expect(h.server.docs.config.onboardingDone).toBe(true);
    expect(h.server.docs.config.tuition).toBeDefined();
  });

  it('the empty backup is a valid, completely empty backup file', () => {
    const doc = JSON.parse(emptyBackupText(0)) as Record<string, unknown>;
    expect(doc).toMatchObject({ app: 'tuition-ticker', kind: 'backup', schemaVersion: 1, config: { schemaVersion: 1 }, marks: { schemaVersion: 1 }, slacks: { schemaVersion: 1 }, calendars: [] });
  });

  it('confirming empties the data on the server, clears the browser storage and reloads the page', async () => {
    const h = await boot({ path: '/settings' });
    localStorage.setItem('tt.scale', '150');
    localStorage.setItem('tt.locale', 'en');
    sessionStorage.setItem('tt.fired', '["x"]');
    expect(h.server.docs.config.onboardingDone).toBe(true);

    const reload = vi.fn();
    let ok = false;
    await act(async () => {
      ok = await confirmReset(reload);
    });
    expect(ok).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(h.server.docs.config.onboardingDone).toBeUndefined();
    expect(h.server.docs.config.tuition).toBeUndefined();
    expect(h.server.docs.config.school).toBeUndefined();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('a failed reset keeps everything and says so', async () => {
    const h = await boot({ path: '/settings' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'import_failed', message: 'disk full' }), { status: 500 })));
    const reload = vi.fn();
    localStorage.setItem('tt.scale', '150');
    let ok = true;
    await act(async () => {
      ok = await confirmReset(reload);
    });
    vi.unstubAllGlobals();
    expect(ok).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(resetError.value).toContain('disk full');
    expect(localStorage.getItem('tt.scale')).toBe('150');
    expect(h.server.docs.config.onboardingDone).toBe(true);
  });
});
