import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendars, config, flushSaves, loadAll, loadStatus, marks, notice, resetDataState, SAVE_DELAY_MS, setConfig, setDoc } from '../../src/state/data';
import { installFakeServer, type FakeServer } from './fake-server';

let server: FakeServer;

beforeEach(() => {
  vi.useFakeTimers();
  resetDataState();
});

afterEach(() => {
  server.restore();
  vi.useRealTimers();
});

describe('data sync: loading', () => {
  it('calls GET /api/data exactly once and fills the state (revs are kept out of the documents)', async () => {
    server = installFakeServer({ config: { currency: 'GBP', onboardingDone: true } }, [{ id: 'cal-a', text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }]);
    server.docs.config.rev = 4;
    await loadAll();
    expect(server.calls.filter((c) => c.method === 'GET' && c.url === '/api/data')).toHaveLength(1);
    expect(server.calls).toHaveLength(1);
    expect(loadStatus.value).toBe('ready');
    expect(config.value).toEqual({ schemaVersion: 1, currency: 'GBP', onboardingDone: true });
    expect('rev' in config.value).toBe(false);
    expect(calendars.value).toEqual([{ id: 'cal-a', text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }]);
  });

  it('reports a failed load without throwing', async () => {
    server = installFakeServer();
    server.restore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await loadAll();
    expect(loadStatus.value).toBe('error');
    vi.unstubAllGlobals();
    server = installFakeServer();
  });
});

describe('data sync: saving', () => {
  it('five changes within 500 ms produce exactly one PUT with the last value and the loaded rev', async () => {
    server = installFakeServer();
    server.docs.config.rev = 3;
    await loadAll();
    for (let i = 1; i <= 5; i++) {
      setConfig({ schemaVersion: 1, school: `v${i}` });
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 100);
    }
    expect(server.puts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    const puts = server.puts('config');
    expect(puts).toHaveLength(1);
    expect(puts[0].json).toEqual({ rev: 3, doc: { schemaVersion: 1, school: 'v5' } });
    expect(puts[0].headers['x-tuition-ticker']).toBe('1');
    expect(server.docs.config.school).toBe('v5');
  });

  it('uses the new rev for the next save', async () => {
    server = installFakeServer();
    await loadAll();
    setConfig({ schemaVersion: 1, school: 'a' });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    setConfig({ schemaVersion: 1, school: 'b' });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(server.puts('config').map((c) => (c.json as { rev: number }).rev)).toEqual([0, 1]);
  });

  it('saves different documents independently', async () => {
    server = installFakeServer();
    await loadAll();
    setConfig({ schemaVersion: 1, school: 'x' });
    setDoc('marks', { schemaVersion: 1, a: 1 });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(server.puts('config')).toHaveLength(1);
    expect(server.puts('marks')).toHaveLength(1);
    expect(marks.value).toEqual({ schemaVersion: 1, a: 1 });
  });

  it('on 409 refetches everything and shows the notice', async () => {
    server = installFakeServer({ config: { school: 'mine' } });
    await loadAll();
    server.conflictNext('config', { school: 'from another tab' });
    setConfig({ schemaVersion: 1, school: 'edited here' });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    // PUT -> 409 -> GET /api/data again
    const kinds = server.calls.map((c) => `${c.method} ${c.url}`);
    expect(kinds).toEqual(['GET /api/data', 'PUT /api/docs/config', 'GET /api/data']);
    expect(notice.value).toBe('数据在别的标签页被改过，已刷新');
    expect(config.value.school).toBe('from another tab');
    // and the next edit is based on the refreshed rev
    setConfig({ schemaVersion: 1, school: 'after refresh' });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(server.puts('config')).toHaveLength(2);
    expect((server.puts('config')[1].json as { rev: number }).rev).toBe(server.docs.config.rev - 1);
  });

  it('keeps the edit and retries when the server fails', async () => {
    server = installFakeServer();
    await loadAll();
    server.failNext(500);
    setConfig({ schemaVersion: 1, school: 'retry me' });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(notice.value).toContain('保存失败');
    await vi.advanceTimersByTimeAsync(6000);
    expect(server.puts('config')).toHaveLength(2);
    expect(server.docs.config.school).toBe('retry me');
  });

  it('flushSaves sends queued changes at once', async () => {
    server = installFakeServer();
    await loadAll();
    setConfig({ schemaVersion: 1, school: 'now' });
    await flushSaves();
    expect(server.puts('config')).toHaveLength(1);
    expect(server.docs.config.school).toBe('now');
  });
});
