// Slacking ("摸鱼"): starting, ending, restoring after a reload, and the numbers shown on the slacking page and the
// settlement card. The amount is never stored: it is derived from the unit price and the overlapping seconds.
//
// Order of events when the user starts slacking: the record `{id, sessionId, startMs}` is written to `slacks` and
// sent to the server (PUT /api/docs/slacks) first; only after that request has been issued does the page switch to
// the slacking view, so a reload never loses a slacking session.

import { effect, signal } from '@preact/signals';
import { findPoolOfSession, getPoolSession } from '../core/billing';
import { pickEquivalent } from '../core/equivalents';
import { formatMinor, type CurrencyCode } from '../core/money';
import { t } from '../i18n';
import { closeFinishedSlacks, slackAmountMinor, slackSeconds, slackSecondsBySession, isSlackRunning } from '../core/slack';
import type { Session, SlackRecord } from '../core/types';
import { demoActive, demoSlacks } from './demoState';
import { flushSaves, setDoc, slacks } from './data';
import { billableSessions, courses, currency, pools } from './derived';
import { rateText } from './dashboard';
import { dashboardModel } from './dashboardState';
import { activeNow } from './now';
import { slackRecords } from './slackRecords';

export { slackRecords } from './slackRecords';

export type SlackUi = { mode: 'slacking' | 'settlement'; recordId: string } | null;

/** What the full-screen slacking layer is showing right now (null = nothing). */
export const slackUi = signal<SlackUi>(null);

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `slack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Store the records: in memory for the demo, otherwise as a debounced save of the `slacks` document. */
function writeRecords(records: SlackRecord[]): void {
  if (demoActive.peek()) demoSlacks.value = { ...demoSlacks.peek(), records };
  else setDoc('slacks', { ...slacks.peek(), records });
}

/** Send the pending `slacks` save immediately (nothing to send in demo mode). */
function flushRecords(): Promise<void> {
  return demoActive.peek() ? Promise.resolve() : flushSaves();
}

let starting = false;

/** Start slacking in `sessionId`. Resolves once the record has been sent and the slacking view is showing. */
export async function startSlack(sessionId: string, nowMs: number): Promise<void> {
  if (starting || slackUi.peek()) return;
  starting = true;
  try {
    const record: SlackRecord = { id: newId(), sessionId, startMs: nowMs };
    writeRecords([...slackRecords.peek(), record]);
    await flushRecords(); // PUT slacks first ...
    slackUi.value = { mode: 'slacking', recordId: record.id }; // ... then show the slacking view
  } finally {
    starting = false;
  }
}

/** "Continue the lecture": close the record (never beyond the end of the class) and show the settlement card. */
export function endSlack(recordId: string, nowMs: number): void {
  const record = slackRecords.peek().find((r) => r.id === recordId);
  if (!record) {
    slackUi.value = null;
    return;
  }
  const session = billableSessions.peek().find((s) => s.id === record.sessionId);
  const endMs = Math.max(record.startMs, Math.min(nowMs, session ? session.endMs : nowMs));
  writeRecords(slackRecords.peek().map((r) => (r.id === recordId ? { ...r, endMs } : r)));
  void flushRecords();
  slackUi.value = { mode: 'settlement', recordId };
}

export function closeSettlement(): void {
  slackUi.value = null;
}

// ------------------------------------------------------------------ numbers for the views

export interface EquivalentView {
  emoji: string;
  name: string;
  unit: string;
  /** Whole items the amount buys (0 below the cheapest item). */
  count: number;
  /** amount / price with one decimal, e.g. "5.9". */
  fractionText: string;
  belowCheapest: boolean;
}

export function equivalentOf(amountMinor: number, cur: CurrencyCode): EquivalentView | null {
  const e = pickEquivalent(amountMinor, cur);
  if (!e) return null;
  return { emoji: e.item.emoji, name: e.item.name, unit: e.item.unit, count: e.count, fractionText: e.fraction.toFixed(1), belowCheapest: e.belowCheapest };
}

export interface SlackContext {
  record: SlackRecord;
  session: Session & { courseId: string };
  label: string;
  ratePerSec: number;
  rateText: string;
  currency: CurrencyCode;
}

/** The record with its session, course label and unit price, or null when the session is unknown. */
export function slackContextOf(recordId: string): SlackContext | null {
  const record = slackRecords.value.find((r) => r.id === recordId);
  if (!record) return null;
  const session = billableSessions.value.find((s) => s.id === record.sessionId);
  if (!session) return null;
  const pool = findPoolOfSession(pools.value, session.id);
  const ratePerSec = (pool ? getPoolSession(pool, session.id)?.ratePerSec : 0) ?? 0;
  const course = courses.value.find((c) => c.id === session.courseId);
  const cur = currency.value;
  return { record, session, label: course?.code ?? course?.name ?? session.title, ratePerSec, rateText: rateText(ratePerSec, cur), currency: cur };
}

export interface SlackLive {
  seconds: number;
  amountMinor: number;
}

export function slackLiveAt(ctx: SlackContext, nowMs: number): SlackLive {
  return { seconds: slackSeconds(ctx.record, ctx.session, nowMs), amountMinor: slackAmountMinor(ctx.record, ctx.session, ctx.ratePerSec, nowMs) };
}

/** Everything the settlement card shows for a closed record. */
export function settlementOf(ctx: SlackContext, nowMs: number): { seconds: number; amountMinor: number; equivalent: EquivalentView | null; sessionTotalSeconds: number } {
  const live = slackLiveAt(ctx, nowMs);
  const sessionsById = new Map([[ctx.session.id, ctx.session]]);
  const total = slackSecondsBySession(slackRecords.value, sessionsById, nowMs).get(ctx.session.id) ?? 0;
  return { ...live, equivalent: equivalentOf(live.amountMinor, ctx.currency), sessionTotalSeconds: total };
}

export function slackTitleOf(ctx: SlackContext, nowMs: number): string {
  return `🐟 ${formatMinor(slackLiveAt(ctx, nowMs).amountMinor, ctx.currency)}`;
}

// ------------------------------------------------------------------ keeping records consistent with the clock

/**
 * - A record still running after its class ended (page was closed, or time passed while slacking) gets
 *   `endMs = class end`; if its slacking view is open it turns into the settlement card.
 * - A running record whose class is on and whose view is not open (page reloaded) re-opens the slacking view.
 * - A view that points to a record that no longer exists (e.g. after leaving demo mode) is closed.
 */
export function reconcileSlacks(nowMs: number): void {
  const sessions = billableSessions.peek();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const { records, changed } = closeFinishedSlacks(slackRecords.peek(), byId, nowMs);
  if (changed.length > 0) writeRecords(records);

  const ui = slackUi.peek();
  if (ui && !records.some((r) => r.id === ui.recordId)) {
    slackUi.value = null;
    return;
  }
  if (ui?.mode === 'slacking' && changed.some((r) => r.id === ui.recordId)) {
    slackUi.value = { mode: 'settlement', recordId: ui.recordId };
    return;
  }
  if (!ui && !starting) {
    const running = records.find((r) => {
      const s = byId.get(r.sessionId);
      return s !== undefined && isSlackRunning(r, s, nowMs);
    });
    if (running) slackUi.value = { mode: 'slacking', recordId: running.id };
  }
}

/** Start watching: runs `reconcileSlacks` whenever the data or the dashboard status changes. Returns a stop function. */
export function startSlackWatcher(): () => void {
  return effect(() => {
    void dashboardModel.value; // changes at every session boundary and whenever the data changes
    void slackRecords.value;
    void billableSessions.value;
    reconcileSlacks(activeNow.peek());
  });
}

// ------------------------------------------------------------------ texts for the slacking page and the settlement card

/** "已经浪费 3 盒三餸饭" style hint for the amount wasted so far (empty when there is no price pack). */
export function equivalentHint(amountMinor: number, cur: CurrencyCode): string {
  const e = equivalentOf(amountMinor, cur);
  if (!e) return '';
  return e.count >= 1
    ? `${e.emoji} ${t('slack.equivalentNow', { count: e.count, unit: e.unit, name: e.name })}`
    : `${e.emoji} ${t('slack.equivalentAlmost', { unit: e.unit, name: e.name })}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "12 分 00 秒" */
export function minSecText(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return t('slack.minSec', { m: Math.floor(s / 60), s: pad2(s % 60) });
}

export interface SettlementTexts {
  amountMinor: number;
  durationLabel: string;
  /** "5.9 盒三餸饭" */
  equivalentLabel: string;
  sessionTotalMinutes: number;
}

export function settlementTexts(ctx: SlackContext, nowMs: number): SettlementTexts {
  const s = settlementOf(ctx, nowMs);
  return {
    amountMinor: s.amountMinor,
    durationLabel: minSecText(s.seconds),
    equivalentLabel: s.equivalent ? `${s.equivalent.fractionText} ${s.equivalent.unit}${s.equivalent.name}` : '',
    sessionTotalMinutes: Math.floor(s.sessionTotalSeconds / 60),
  };
}
