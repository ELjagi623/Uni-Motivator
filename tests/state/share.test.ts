// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SHARE_HEIGHT, SHARE_WIDTH, buildShareCardData, drawShareCard, pngSize, renderShareCardPng, shareFileName, type Canvas2D, type ShareCanvas } from '../../src/state/share';
import { NOWS, fixtureConfig, fullTermText, hk, inputsFor } from './fixture-app';

const THEME = {
  colors: { bg: 'bg', surface: 'surface', surface2: 'surface2', text: 'text', muted: 'muted', number: 'number', accent: 'accent' },
  fonts: { number: 'NumFont', body: 'BodyFont' },
};

function recordingCanvas() {
  const drawn: Array<{ text: string; x: number; y: number; maxWidth?: number; font: string }> = [];
  const ctx: Canvas2D = {
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillRect() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    fill() {},
    fillText(text, x, y, maxWidth) {
      drawn.push({ text, x, y, maxWidth, font: ctx.font });
    },
  };
  const canvas: ShareCanvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    // a minimal PNG: signature, IHDR chunk header, width, height (taken from the canvas as it is at encoding time)
    toBlob(callback) {
      const bytes = new Uint8Array(33);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      const view = new DataView(bytes.buffer);
      view.setUint32(16, canvas.width);
      view.setUint32(20, canvas.height);
      callback(new Blob([bytes], { type: 'image/png' }));
    },
  };
  return { canvas, drawn };
}

const slacks = [{ id: 'r1', sessionId: 'ft-mon-s1@fixture|2026-11-09T01:00:00Z', startMs: hk('2026-11-09T10:00:00'), endMs: hk('2026-11-09T10:20:00') }];
const marks = { 'ft-mon-s1@fixture|2026-11-02T01:00:00Z': { status: 'skipped' as const } };

describe('share card', () => {
  const config = { ...fixtureConfig(), school: 'TESTSCHOOL' };
  const inputs = inputsFor(config, [fullTermText], { slacks, marks });

  it('is a 1080 x 1440 PNG', async () => {
    const { canvas } = recordingCanvas();
    const { blob } = await renderShareCardPng(buildShareCardData(inputs, NOWS.doneToday), canvas, THEME);
    expect(canvas.width).toBe(SHARE_WIDTH);
    expect(canvas.height).toBe(SHARE_HEIGHT);
    expect([SHARE_WIDTH, SHARE_HEIGHT]).toEqual([1080, 1440]);
    expect(blob.type).toBe('image/png');
    expect(pngSize(new Uint8Array(await blob.arrayBuffer()))).toEqual({ width: 1080, height: 1440 });
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('draws money, slacking, an equivalent and attendance - and nothing that identifies the user (school name TESTSCHOOL)', async () => {
    const { canvas, drawn } = recordingCanvas();
    const data = buildShareCardData(inputs, NOWS.doneToday);
    const { texts } = await renderShareCardPng(data, canvas, THEME);
    expect(texts).toEqual(drawn.map((d) => d.text));
    const all = texts.join('\n');
    expect(all).not.toContain('TESTSCHOOL');
    expect(JSON.stringify(data)).not.toContain('TESTSCHOOL');
    expect(texts).toContain('HK$13,724.14'); // this class (the last one that ended) and this week
    expect(all).toMatch(/本周/);
    expect(all).toMatch(/本学期/);
    expect(all).toMatch(/HK\$[\d,]+\.\d{2}/);
    expect(all).toMatch(/摸鱼/);
    expect(all).toMatch(/20 分钟/);
    expect(all).toMatch(/相当于 \d/); // the equivalent
    expect(all).toMatch(/出勤率/);
    expect(texts.some((x) => /^\d+%$/.test(x))).toBe(true);
    // every text fits: long ones carry a maxWidth (they shrink, they are not cut off) and stay inside the 1080 px card
    for (const d of drawn) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(SHARE_WIDTH);
      expect(d.y).toBeLessThanOrEqual(SHARE_HEIGHT);
    }
    expect(drawn.find((d) => d.text.startsWith('HK$') && d.font.includes('112px'))?.maxWidth).toBe(840);
    // colours and fonts come from the theme that was passed in, not from literals
    expect(drawn[0].font).toContain('BodyFont');
  });

  it('the data type has no identity field at all', () => {
    const data = buildShareCardData(inputs, NOWS.doneToday);
    expect(Object.keys(data).sort()).toEqual(['attendance', 'dateLine', 'equivalent', 'footer', 'headlineCaption', 'slack', 'spent', 'title']);
  });

  it('without slacking the equivalent is about the tuition spent; with no class yet it still draws', () => {
    const plain = buildShareCardData(inputsFor(config, [fullTermText]), NOWS.doneToday);
    expect(plain.equivalent).toContain('花掉的学费相当于');
    const early = buildShareCardData(inputsFor(config, [fullTermText]), NOWS.beforeTerm);
    const ctx = recordingCanvas();
    expect(() => drawShareCard(ctx.canvas.getContext('2d') as Canvas2D, early, THEME.colors, THEME.fonts)).not.toThrow();
    expect(early.spent[0].value).toBe('HK$0.00');
  });

  it('names the download file with the date and the .png extension', () => {
    expect(shareFileName(hk('2026-11-12T10:00:00'))).toBe('tuition-ticker-2026-11-12.png');
  });
});
