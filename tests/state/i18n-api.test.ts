import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteCalendar, getData, postCalendar, putDoc } from '../../src/api/client';
import { t, type MessageKey } from '../../src/i18n';
import { zhCN } from '../../src/i18n/zh-CN';
import { installFakeServer, type FakeServer } from './fake-server';

describe('i18n', () => {
  it('fills {placeholders}, leaves unknown ones alone, and returns the key for an unknown message', () => {
    expect(t('onboarding.stepOfTotal', { n: 3, total: 7 })).toBe('3 / 7');
    expect(t('onboarding.stepOfTotal', { n: 3 })).toBe('3 / {total}');
    expect(t('does.not.exist' as MessageKey)).toBe('does.not.exist');
    expect(t('onboarding.next')).toBe('下一步');
  });

  it('every placeholder in a message is a plain word and no message is empty', () => {
    for (const [key, value] of Object.entries(zhCN)) {
      expect(value.length, key).toBeGreaterThan(0);
      for (const m of value.matchAll(/\{([^}]*)\}/g)) expect(m[1], key).toMatch(/^\w+$/);
    }
  });
});

describe('api client', () => {
  let server: FakeServer;
  afterEach(() => server.restore());

  it('sends the X-Tuition-Ticker header on every write and not on reads', async () => {
    server = installFakeServer();
    await getData();
    await putDoc('config', 0, { schemaVersion: 1 });
    const id = await postCalendar('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    await deleteCalendar(id);
    const [read, ...writes] = server.calls;
    expect(read.headers['x-tuition-ticker']).toBeUndefined();
    expect(writes).toHaveLength(3);
    for (const w of writes) expect(w.headers['x-tuition-ticker'], `${w.method} ${w.url}`).toBe('1');
  });

  it('reports a stale rev as a conflict result and other failures as errors', async () => {
    server = installFakeServer();
    expect(await putDoc('config', 5, { schemaVersion: 1 })).toMatchObject({ ok: false, conflict: true });
    server.failNext(500);
    await expect(putDoc('config', 0, { schemaVersion: 1 })).rejects.toThrow('server said no');
  });

  it('percent-encodes the calendar id when deleting', async () => {
    server = installFakeServer();
    vi.spyOn(globalThis, 'fetch');
    await deleteCalendar('../x');
    expect(server.calls[0].url).toBe('/api/calendars/..%2Fx');
  });
});
