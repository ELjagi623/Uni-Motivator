// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { options, render } from 'preact';
import { act } from 'preact/test-utils';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyCarousel } from '../../src/ui/components/CopyCarousel';
import { TickingNumber, TickingText } from '../../src/ui/components/Ticking';

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  render(null, host);
  host.remove();
  vi.useRealTimers();
});

describe('TickingNumber', () => {
  it('does not re-render while the time changes 60 times: its function body runs at most once', async () => {
    const now = signal(1_000_000);
    let bodyRuns = 0;
    const previous = options.diffed;
    options.diffed = (vnode) => {
      if (vnode.type === TickingNumber) bodyRuns += 1;
      previous?.(vnode);
    };
    try {
      await act(async () => {
        render(<TickingNumber now={now} field="amount" compute={(t) => Math.round(t * 12.5)} />, host);
      });
      const el = host.querySelector<HTMLElement>('[data-field="amount"]')!;
      const texts = new Set<string>();
      for (let i = 1; i <= 60; i++) {
        now.value = 1_000_000 + i * 1000;
        const text = el.textContent ?? '';
        expect(text, `update ${i}`).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/); // two decimals, thousands separators
        texts.add(text);
      }
      expect(texts.size).toBeGreaterThan(50); // it really did change
      expect(bodyRuns).toBeLessThanOrEqual(1);
      expect(host.querySelector('[data-field="amount"]')).toBe(el); // the same element throughout
      expect(el.textContent).toBe('132,500.00'); // round(12.5 x 1,060,000) = 13,250,000 minor units
    } finally {
      options.diffed = previous;
    }
  });

  it('is in tabular figures, hidden from screen readers and not inside a live region', async () => {
    const now = signal(5000);
    await act(async () => {
      render(
        <div>
          <TickingNumber now={now} field="n" compute={() => 123456789} />
        </div>,
        host,
      );
    });
    const el = host.querySelector<HTMLElement>('[data-field="n"]')!;
    expect(el.textContent).toBe('1,234,567.89');
    expect(el.classList.contains('num')).toBe(true);
    const base = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'styles', 'base.css'), 'utf8');
    expect(base).toMatch(/\.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('aria-live')).toBe(false);
    expect(el.closest('[aria-live]')).toBeNull();
  });

  it('TickingText updates in place too', async () => {
    const now = signal(0);
    await act(async () => {
      render(<TickingText now={now} field="t" compute={(t) => `t=${t}`} />, host);
    });
    const el = host.querySelector<HTMLElement>('[data-field="t"]')!;
    now.value = 7;
    expect(el.textContent).toBe('t=7');
  });
});

describe('CopyCarousel', () => {
  it('changes the line every 8 seconds and never repeats the previous line', async () => {
    vi.useFakeTimers();
    let n = 0;
    const random = () => {
      n += 1;
      return ((n * 7) % 10) / 10; // deterministic, varied
    };
    await act(async () => {
      render(<CopyCarousel scene="in-class" random={random} getVars={() => ({ course: 'MFIN7002', amount: 'HK$1.00', rate: 'HK$1.2708', minutes: 30 })} />, host);
    });
    const line = () => host.querySelector('#copy-line')?.textContent ?? '';
    const seen = [line()];
    expect(seen[0]).not.toBe('');
    expect(seen[0]).not.toMatch(/[{}]/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7999);
    });
    expect(line()).toBe(seen[0]); // not yet
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(i === 0 ? 1 : 8000);
      });
      seen.push(line());
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `change ${i}`).not.toBe(seen[i - 1]);
      expect(seen[i]).not.toMatch(/[{}]/);
    }
    expect(new Set(seen).size).toBeGreaterThan(3);
  });
});
