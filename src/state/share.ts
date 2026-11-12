// The share card: a 1080 x 1440 (3:4) picture drawn with Canvas 2D, saved as a PNG.
//
// Privacy by construction: `ShareCardData` has no field for a name, a school or anything else that identifies the
// user - only money, minutes, an equivalent and an attendance rate - and `buildShareCardData` is only handed the
// timetable numbers (never the config). `drawShareCard` returns the list of every text it drew, so a test can assert
// that e.g. a school name never reaches the picture.
//
// Colours and fonts are read from the design tokens (CSS variables) at drawing time, so the card follows the theme.

import { signal } from '@preact/signals';
import { sessionStateAt, findPoolOfSession } from '../core/billing';
import { formatMinor } from '../core/money';
import { t } from '../i18n';
import { dateText, type DashboardInputs } from './dashboard';
import { equivalentOf } from './slack';
import { buildStatsModel } from './stats';
import { dashboardInputs } from './dashboardState';
import { activeNow } from './now';

export const SHARE_WIDTH = 1080;
export const SHARE_HEIGHT = 1440;

export interface ShareRow {
  label: string;
  value: string;
}

/** Everything the card shows, as ready-made text. No identity fields on purpose. */
export interface ShareCardData {
  title: string;
  /** "2026-11-12" */
  dateLine: string;
  /** "本节", "本周", "本学期" with the money spent in each (the last one is the headline). */
  spent: [ShareRow, ShareRow, ShareRow];
  slack: ShareRow;
  attendance: ShareRow;
  /** One line with an emoji, e.g. "🍱 摸鱼的钱相当于 5.9 盒三餸饭". */
  equivalent: string;
  footer: string;
  /** Small caption above the headline number. */
  headlineCaption: string;
}

export interface ShareColors {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  muted: string;
  number: string;
  accent: string;
}

export interface ShareFonts {
  number: string;
  body: string;
}

/** The part of CanvasRenderingContext2D the card uses (so tests can pass a recording stand-in). */
export interface Canvas2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  fill(): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

// ------------------------------------------------------------------ the data

function equivalentLine(amountMinor: number, currency: DashboardInputs['currency'], key: 'share.equivalentSlack' | 'share.equivalentSpent'): string {
  const e = equivalentOf(amountMinor, currency);
  if (!e) return '';
  const item = e.count >= 1 ? e : { ...e, ...e.many };
  const amount = e.count >= 1 ? String(e.count) : e.fractionText;
  return `${e.emoji} ${t(key, { text: t('share.itemPhrase', { amount, unit: item.unit, name: item.name }) })}`;
}

/** The card's content at `nowMs`: this class, this week, this semester; slacking, attendance and an equivalent. */
export function buildShareCardData(inputs: DashboardInputs, nowMs: number): ShareCardData {
  const stats = buildStatsModel(inputs, nowMs);
  const currency = inputs.currency;

  // "This class": the one in progress (what has burned so far), otherwise the one that ended last (its whole cost).
  let sessionMinor = 0;
  let latestEnd = -Infinity;
  for (const s of inputs.sessions) {
    const pool = findPoolOfSession(inputs.pools, s.id);
    if (!pool) continue;
    if (s.startMs <= nowMs && nowMs < s.endMs) {
      sessionMinor = sessionStateAt(pool, s.id, nowMs)?.consumedMinor ?? 0;
      latestEnd = Infinity;
    } else if (s.endMs <= nowMs && s.endMs > latestEnd) {
      latestEnd = s.endMs;
      sessionMinor = sessionStateAt(pool, s.id, nowMs)?.costMinor ?? 0;
    }
  }

  const semester = stats.semester;
  const slackMinor = semester?.slackMinor ?? 0;
  const spentMinor = semester?.costMinor ?? 0;
  const equivalent = slackMinor > 0 ? equivalentLine(slackMinor, currency, 'share.equivalentSlack') : equivalentLine(spentMinor, currency, 'share.equivalentSpent');

  return {
    title: t('notify.title'),
    dateLine: dateText(nowMs),
    headlineCaption: t('share.spentCaption', { period: semester ? stats.semesterLabel : t('stats.semester') }),
    spent: [
      { label: t('share.session'), value: formatMinor(sessionMinor, currency) },
      { label: t('share.week'), value: stats.week.spentText },
      { label: stats.semesterLabel || t('share.semester'), value: semester?.spentText ?? formatMinor(0, currency) },
    ],
    slack: { label: t('share.slack'), value: semester ? semester.slackText : t('share.slackLine', { minutes: 0, amount: formatMinor(0, currency) }) },
    attendance: { label: t('share.attendance'), value: semester?.attendanceText ?? t('sessions.noValue') },
    equivalent,
    footer: t('share.footer'),
  };
}

// ------------------------------------------------------------------ drawing

function roundRect(ctx: Canvas2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw the card on a 1080 x 1440 context. Long texts shrink to fit (`maxWidth`) instead of being cut off.
 * @returns every text that was drawn, in drawing order
 */
export function drawShareCard(ctx: Canvas2D, data: ShareCardData, colors: ShareColors, fonts: ShareFonts): string[] {
  const drawn: string[] = [];
  const text = (value: string, x: number, y: number, o: { size: number; weight: number; family: string; color: string; align?: CanvasTextAlign; maxWidth?: number }): void => {
    if (value === '') return;
    ctx.font = `${o.weight} ${o.size}px ${o.family}`;
    ctx.fillStyle = o.color;
    ctx.textAlign = o.align ?? 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(value, x, y, o.maxWidth);
    drawn.push(value);
  };

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, SHARE_WIDTH, SHARE_HEIGHT);
  ctx.fillStyle = colors.surface;
  roundRect(ctx, 60, 60, SHARE_WIDTH - 120, SHARE_HEIGHT - 120, 48);

  // header
  text(data.title, 120, 160, { size: 40, weight: 700, family: fonts.body, color: colors.muted });
  text(data.dateLine, SHARE_WIDTH - 120, 160, { size: 36, weight: 700, family: fonts.number, color: colors.muted, align: 'right' });

  // headline: this semester
  text(data.headlineCaption, 120, 290, { size: 40, weight: 700, family: fonts.body, color: colors.muted, maxWidth: 840 });
  text(data.spent[2].value, 120, 420, { size: 112, weight: 800, family: fonts.number, color: colors.number, maxWidth: 840 });

  // rows
  const rows: Array<{ row: ShareRow; accent?: boolean }> = [{ row: data.spent[0] }, { row: data.spent[1] }, { row: data.slack, accent: true }, { row: data.attendance }];
  let y = 590;
  for (const { row, accent } of rows) {
    ctx.fillStyle = colors.surface2;
    roundRect(ctx, 120, y - 64, SHARE_WIDTH - 240, 104, 28);
    text(row.label, 156, y + 4, { size: 40, weight: 700, family: fonts.body, color: colors.muted });
    text(row.value, SHARE_WIDTH - 156, y + 8, { size: 48, weight: 800, family: fonts.number, color: accent ? colors.accent : colors.number, align: 'right', maxWidth: 560 });
    y += 136;
  }

  // equivalent
  if (data.equivalent) {
    ctx.fillStyle = colors.surface2;
    roundRect(ctx, 120, 1130, SHARE_WIDTH - 240, 120, 36);
    text(data.equivalent, SHARE_WIDTH / 2, 1204, { size: 44, weight: 700, family: fonts.body, color: colors.text, align: 'center', maxWidth: 800 });
  }

  text(data.footer, SHARE_WIDTH / 2, 1320, { size: 34, weight: 700, family: fonts.body, color: colors.muted, align: 'center', maxWidth: 840 });
  return drawn;
}

/** Read the card's colours and fonts from the design tokens (the theme in effect). */
export function readShareTheme(root: Element = document.documentElement): { colors: ShareColors; fonts: ShareFonts } {
  const css = getComputedStyle(root);
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    colors: {
      bg: v('--color-bg', 'transparent'),
      surface: v('--color-surface', 'transparent'),
      surface2: v('--color-surface-2', 'transparent'),
      text: v('--color-text', 'currentColor'),
      muted: v('--color-text-muted', 'currentColor'),
      number: v('--color-number', 'currentColor'),
      accent: v('--color-accent', 'currentColor'),
    },
    fonts: { number: v('--font-number', 'sans-serif'), body: v('--font-body', 'sans-serif') },
  };
}

// ------------------------------------------------------------------ PNG

/** Width and height from a PNG file's header, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function shareFileName(nowMs: number): string {
  return `tuition-ticker-${dateText(nowMs)}.png`;
}

export interface ShareCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): Canvas2D | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

/** Draw `data` on a canvas of exactly 1080 x 1440 and return the PNG. */
export async function renderShareCardPng(data: ShareCardData, canvas: ShareCanvas = document.createElement('canvas') as unknown as ShareCanvas, theme = readShareTheme()): Promise<{ blob: Blob; texts: string[] }> {
  canvas.width = SHARE_WIDTH;
  canvas.height = SHARE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  const texts = drawShareCard(ctx, data, theme.colors, theme.fonts);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not encode the PNG');
  return { blob, texts };
}

// ------------------------------------------------------------------ app state

export interface ShareResult {
  url: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
}

export const shareResult = signal<ShareResult | null>(null);
export const shareError = signal<string | null>(null);
export const shareBusy = signal(false);

/** Build the card for "now", draw it and offer it for download. */
export async function generateShareCard(): Promise<ShareResult | null> {
  shareBusy.value = true;
  shareError.value = null;
  try {
    const nowMs = activeNow.peek();
    const { blob } = await renderShareCardPng(buildShareCardData(dashboardInputs.peek(), nowMs));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const size = pngSize(bytes);
    const previous = shareResult.peek();
    if (previous) URL.revokeObjectURL(previous.url);
    const result: ShareResult = { url: URL.createObjectURL(blob), fileName: shareFileName(nowMs), width: size?.width ?? 0, height: size?.height ?? 0, bytes: bytes.length };
    shareResult.value = result;
    return result;
  } catch {
    shareError.value = t('share.failed');
    return null;
  } finally {
    shareBusy.value = false;
  }
}

/** Test / debug helper: the generated PNG's header facts (see `window.__tt_debug.shareCard`). */
export async function shareCardFacts(): Promise<{ width: number; height: number; type: string; bytes: number; fileName: string; texts: string[] } | null> {
  const nowMs = activeNow.peek();
  const { blob, texts } = await renderShareCardPng(buildShareCardData(dashboardInputs.peek(), nowMs));
  const size = pngSize(new Uint8Array(await blob.arrayBuffer()));
  return size ? { ...size, type: blob.type, bytes: blob.size, fileName: shareFileName(nowMs), texts } : null;
}

export function resetShareState(): void {
  const previous = shareResult.peek();
  if (previous) URL.revokeObjectURL(previous.url);
  shareResult.value = null;
  shareError.value = null;
  shareBusy.value = false;
}
