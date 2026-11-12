// The slacking page (full screen, warm gradient, floating light spots that are animated by CSS only) and the
// settlement card that pops up when the user goes back to the lecture. The amount is derived from the unit price
// and the seconds slacked; it is never stored.

import { useEffect, useRef } from 'preact/hooks';
import { formatAmountMinor, getCurrency } from '../../core/money';
import { t } from '../../i18n';
import { durationText } from '../../state/dashboard';
import {
  closeSettlement,
  endSlack,
  equivalentHint,
  settlementTexts,
  slackContextOf,
  slackLiveAt,
  slackUi,
  type SlackContext,
} from '../../state/slack';
import { activeNow } from '../../state/now';
import { TickingNumber, TickingText } from '../components/Ticking';

function SlackingView({ ctx }: { ctx: SlackContext }) {
  const symbol = getCurrency(ctx.currency).symbol;
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => buttonRef.current?.focus(), []);
  return (
    <div class="slack-screen slackbg" id="slack-page" role="region" aria-label={t('slack.pageAria')}>
      <span class="orb orb--1" />
      <span class="orb orb--2" />
      <span class="orb orb--3" />
      <div class="slack-content">
        <span class="label slack-label">{t('slack.wasted')}</span>
        <div class="hero-row slack-hero">
          <span class="num slack-currency money">{symbol}</span>
          <TickingNumber class="slack-number money" field="slack-amount" compute={(nowMs) => slackLiveAt(ctx, nowMs).amountMinor} />
        </div>
        <span class="pill slack-pill" id="slack-equivalent">
          <TickingText field="slack-equivalent" compute={(nowMs) => equivalentHint(slackLiveAt(ctx, nowMs).amountMinor, ctx.currency)} />
        </span>
        <span>
          {t('slack.duration')}{' '}
          <b class="num">
            <TickingText field="slack-duration" compute={(nowMs) => durationText(slackLiveAt(ctx, nowMs).seconds)} />
          </b>
        </span>
        <button ref={buttonRef} type="button" id="continue-btn" class="btn slack-continue" onClick={() => endSlack(ctx.record.id, activeNow.peek())}>
          {t('slack.continue')}
        </button>
        <span class="sr-only" aria-live="polite" id="slack-live">
          {t('slack.liveNote', { course: ctx.label })}
        </span>
      </div>
    </div>
  );
}

function SettlementCard({ ctx }: { ctx: SlackContext }) {
  const symbol = getCurrency(ctx.currency).symbol;
  const texts = settlementTexts(ctx, activeNow.peek());
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => buttonRef.current?.focus(), []);
  return (
    <div class="settle-backdrop" id="settlement">
      <div class="card settle-card" role="dialog" aria-modal="true" aria-labelledby="settle-title">
        <span class="h2" id="settle-title">
          {t('slack.settleTitle')}
        </span>
        <div class="hero-row">
          <span class="num accent settle-currency money">{symbol}</span>
          <span class="num settle-number money" data-field="settle-amount">
            {formatAmountMinor(texts.amountMinor)}
          </span>
        </div>
        <div class="row-between">
          <span class="muted">{t('slack.settleDuration')}</span>
          <b class="num" data-field="settle-duration">
            {texts.durationLabel}
          </b>
        </div>
        {texts.equivalentLabel ? (
          <div class="row-between">
            <span class="muted">{t('slack.settleEquivalent')}</span>
            <b data-field="settle-equivalent">{texts.equivalentLabel}</b>
          </div>
        ) : null}
        <div class="row-between">
          <span class="muted">{t('slack.settleTotal')}</span>
          <b class="num" data-field="settle-total">
            {t('slack.minutes', { n: texts.sessionTotalMinutes })}
          </b>
        </div>
        <button ref={buttonRef} type="button" id="settle-close" class="btn btn--primary settle-close" onClick={closeSettlement}>
          {t('slack.back')}
        </button>
      </div>
    </div>
  );
}

export function SlackLayer() {
  const ui = slackUi.value;
  if (!ui) return null;
  const ctx = slackContextOf(ui.recordId);
  if (!ctx) return null;
  return ui.mode === 'slacking' ? <SlackingView ctx={ctx} /> : <SettlementCard ctx={ctx} />;
}

