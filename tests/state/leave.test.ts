// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushForLeave, installLeaveFlush, loadAll, resetDataState, setDoc, marks, SAVE_DELAY_MS } from '../../src/state/data';
import { setMark } from '../../src/state/marks';
import { installFakeServer, type FakeServer } from './fake-server';

let server: FakeServer;
let remove: () => void;

beforeEach(async () => {
  resetDataState();
  server = installFakeServer();
  await loadAll();
  remove = installLeaveFlush();
});

afterEach(() => {
  remove();
  server.restore();
  vi.useRealTimers();
});

describe('pending edits are sent when the page goes away', () => {
  it('pagehide sends the pending marks at once, with keepalive and the write header (not after the 500 ms debounce)', () => {
    setMark('wk@t|2026-11-12T10:00:00Z', 'skipped');
    expect(server.puts('marks')).toHaveLength(0); // still waiting for the debounce
    window.dispatchEvent(new Event('pagehide'));
    const puts = server.puts('marks');
    expect(puts).toHaveLength(1);
    expect(puts[0].keepalive).toBe(true);
    expect(puts[0].headers['x-tuition-ticker']).toBe('1');
    expect((puts[0].json as { doc: { marks: object } }).doc.marks).toEqual({ 'wk@t|2026-11-12T10:00:00Z': { status: 'skipped' } });
  });

  it('visibilitychange to hidden does the same; visible again does nothing; the debounce timer does not send a second copy', async () => {
    vi.useFakeTimers();
    setDoc('marks', { ...marks.value, marks: { x: { status: 'cancelled' } } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(server.puts('marks')).toHaveLength(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(server.puts('marks')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 3);
    expect(server.puts('marks')).toHaveLength(1);
    expect(server.docs.marks.marks).toEqual({ x: { status: 'cancelled' } });
  });

  it('nothing pending means no request; a failing request is silent (no error notice)', async () => {
    flushForLeave();
    expect(server.puts()).toHaveLength(0);
    server.failNext(500);
    setDoc('marks', { ...marks.value, marks: { y: { status: 'skipped' } } });
    flushForLeave();
    await new Promise((r) => setTimeout(r, 20));
    const { notice } = await import('../../src/state/data');
    expect(notice.value).toBeNull();
  });
});
