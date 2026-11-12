// The main screen. One of six layouts, chosen by the status state machine in core (`getStatus`). Only one big number
// is emphasised per screen. Numbers that move with time are TickingNumber / TickingText (written straight into the
// DOM); everything else is rendered from the model, which only changes at session boundaries or when data changes.

import { formatAmountMinor, formatMinor, getCurrency, type CurrencyCode } from '../../core/money';
import { t, type MessageKey } from '../../i18n';
import {
  breakCopyVars,
  durationText,
  inClassCopyVars,
  liveAt,
  minutesOf,
  shownView,
  summaryText,
  type DashboardModel,
  type SessionView,
} from '../../state/dashboard';
import { chooseSession, dashboardModel, selectedSessionId } from '../../state/dashboardState';
import { activeNow, minuteBucket } from '../../state/now';
import { activeConfig } from '../../state/source';
import { demoActive } from '../../state/demoState';
import { slackUi, startSlack } from '../../state/slack';
import { Button } from '../components/controls';
import { CopyCarousel } from '../components/CopyCarousel';
import { SecondaryAmount } from '../components/Secondary';
import { TickingNumber, TickingText } from '../components/Ticking';
import { Timeline } from '../components/Timeline';
import { TuitionTank } from '../components/TuitionTank';

const STATUS_KEYS: Record<DashboardModel['kind'], MessageKey> = {
  'in-class': 'dashboard.status.inClass',
  break: 'dashboard.status.break',
  'done-today': 'dashboard.status.doneToday',
  'no-class-today': 'dashboard.status.noClassToday',
  'before-term': 'dashboard.status.beforeTerm',
  'after-term': 'dashboard.status.afterTerm',
};

function Money({ minor, currency, field }: { minor: number; currency: CurrencyCode; field?: string }) {
  return (
    <span class="num money" data-field={field}>
      {formatMinor(minor, currency)}
    </span>
  );
}

function poolTitle(model: DashboardModel): string {
  const pool = model.pool;
  if (!pool) return '';
  return pool.semester === null ? t('dashboard.poolYear', { year: pool.year }) : t('dashboard.poolSemester', { year: pool.year, n: pool.semester });
}

/** Visually hidden sentence for screen readers; refreshed at most once a minute. */
function LiveSummary({ model, selectedId }: { model: DashboardModel; selectedId: string | null }) {
  void minuteBucket.value; // re-render once a minute
  return (
    <p class="sr-only" id="live-summary" aria-live="polite">
      {summaryText(model, selectedId, activeNow.peek())}
    </p>
  );
}

// ------------------------------------------------------------------ the six layouts

function InClass({ model, view }: { model: DashboardModel; view: SessionView }) {
  const symbol = getCurrency(model.currency).symbol;
  const others = model.active.filter((v) => v.id !== view.id);
  const course = view.courseCode && !view.courseName.includes(view.courseCode) ? `${view.courseCode} ${view.courseName}` : view.courseName;
  return (
    <>
      <p class="muted" id="course-line">
        <span data-field="course">{course}</span>
        {view.ordinal ? (
          <>
            {' · '}
            <span data-field="session-index">{t('dashboard.sessionOf', { i: view.ordinal.index, n: view.ordinal.total })}</span>
          </>
        ) : null}
      </p>
      {others.length > 0 ? (
        <div class="overlap" role="group" aria-label={t('dashboard.overlapAria')}>
          <span class="muted small">{t('dashboard.overlapNote', { n: model.active.length })}</span>
          {others.map((v) => (
            <Button key={v.id} small variant="ghost" onClick={() => chooseSession(v.id)}>
              {t('dashboard.switchTo', { name: v.label })}
            </Button>
          ))}
        </div>
      ) : null}
      <div class="dash-hero">
        <span class="label">{t('dashboard.consumed')}</span>
        <div class="hero-row">
          <span class="num accent hero-currency money">{symbol}</span>
          <TickingNumber class="hero-number money" field="session-consumed" compute={(nowMs) => liveAt(model, view.id, nowMs).sessionConsumedMinor} />
        </div>
        <SecondaryAmount field="session-consumed-second" compute={(nowMs) => liveAt(model, view.id, nowMs).sessionConsumedMinor} />
        <p class="muted dash-meta">
          {t('dashboard.rate')} <b class="num money" data-field="rate-per-sec">{view.rateText}</b> · {t('dashboard.elapsed')}{' '}
          <b class="num"><TickingText field="elapsed" compute={(nowMs) => durationText(liveAt(model, view.id, nowMs).elapsedSec)} /></b> · {t('dashboard.timeLeft')}{' '}
          <b class="num"><TickingText field="time-left" compute={(nowMs) => durationText(liveAt(model, view.id, nowMs).remainingSec)} /></b>
        </p>
        <p class="muted small">
          {t('dashboard.sessionLeft')}{' '}
          <span class="money">
            {symbol}
            <TickingNumber field="session-remaining" compute={(nowMs) => liveAt(model, view.id, nowMs).sessionRemainingMinor} />
          </span>{' '}
          · {t('dashboard.sessionCost')} <Money minor={view.costMinor} currency={model.currency} field="session-cost" />
        </p>
      </div>
      <Timeline model={model} />
      <div class="dash-cards">
        <TuitionTank model={model} currency={model.currency} sessionId={view.id} />
        <div class="card carousel-card">
          <span class="label">{t('dashboard.carouselLabel')}</span>
          <CopyCarousel class="carousel-text money" scene="in-class" getVars={() => inClassCopyVars(model, view, activeNow.peek())} />
          <span class="muted small" id="slack-today">
            {t('dashboard.slackToday', { minutes: minutesOf(model.slackToday.seconds) })} · {t('dashboard.slackWasted')} <Money minor={model.slackToday.amountMinor} currency={model.currency} field="slack-today-amount" />
          </span>
        </div>
      </div>
    </>
  );
}

function Break({ model }: { model: DashboardModel }) {
  const next = model.next;
  if (!next) return null;
  const prev = model.prev;
  const settle = model.prevSettlement;
  return (
    <>
      <div class="card state-card">
        <span class="label">{t('dashboard.nextClass', { time: next.startText, course: next.label })}</span>
        <TickingText class="num state-number" field="countdown" compute={(nowMs) => durationText(liveAt(model, next.id, nowMs).countdownSec)} />
        <span class="muted small">
          {t('dashboard.countdownNote')} <Money minor={next.costMinor} currency={model.currency} field="next-cost" />
        </span>
        {prev && settle ? (
          <div class="card inset" id="prev-settlement">
            <span class="label">{t('dashboard.prevSettlement')}</span>
            <div class="row-between">
              <span>{prev.label}</span>
              <b class="num">
                <Money minor={settle.costMinor} currency={model.currency} field="prev-cost" />
              </b>
            </div>
            <span class="muted small">
              {settle.slackSeconds > 0
                ? t('dashboard.prevSlack', { minutes: minutesOf(settle.slackSeconds) })
                : t('dashboard.prevNoSlack')}
              {settle.slackSeconds > 0 ? <> · {t('dashboard.slackWasted')} <Money minor={settle.slackAmountMinor} currency={model.currency} /></> : null}
            </span>
          </div>
        ) : null}
        <CopyCarousel class="break-copy muted" scene="break" getVars={() => breakCopyVars(model, next.id, next.label, activeNow.peek())} />
        <Timeline model={model} />
      </div>
      <TuitionTank model={model} currency={model.currency} sessionId={next.id} />
    </>
  );
}

function Today({ model, empty }: { model: DashboardModel; empty: boolean }) {
  const next = model.next;
  return (
    <>
      <div class="card state-card">
        <span class="label">{t('dashboard.todaySummary')}</span>
        <span class="num state-number money" data-field="today-spent">
          {formatMinor(empty ? 0 : model.todaySpentMinor, model.currency)}
        </span>
        <SecondaryAmount field="today-spent-second" minor={empty ? 0 : model.todaySpentMinor} />
        <span class="muted small">
          {empty ? t('dashboard.noClassNote') : t('dashboard.doneNote', { n: model.timeline.length })}
          {next && model.nextWhen ? (
            <>
              {' '}
              {t('dashboard.nextTime')} <b>{t('dashboard.nextWhen', { weekday: model.nextWhen.weekday, time: model.nextWhen.time })}</b> · {next.label}
            </>
          ) : null}
        </span>
        <Timeline model={model} />
      </div>
      <TuitionTank model={model} currency={model.currency} sessionId={null} />
      <p class="muted small" id="state-footnote">
        {empty ? t('dashboard.noClassFoot') : t('dashboard.doneFoot')}
      </p>
    </>
  );
}

function BeforeTerm({ model }: { model: DashboardModel }) {
  const next = model.next;
  const term = model.term;
  return (
    <div class="card state-card">
      <span class="label">{t('dashboard.untilTerm')}</span>
      <span class="num state-number" data-field="days-until-term">
        {t('dashboard.days', { n: model.daysUntilTerm ?? 0 })}
      </span>
      {next && model.nextWhen ? (
        <span class="muted small">{t('dashboard.firstClass', { date: model.nextWhen.date, weekday: model.nextWhen.weekday, time: model.nextWhen.time })}</span>
      ) : null}
      {term ? (
        <div class="card inset" id="term-card">
          <span class="label">{t('dashboard.termTuition')}</span>
          <div class="hero-row">
            <span class="num accent money">{getCurrency(model.currency).symbol}</span>
            <b class="num term-figure money" data-field="pool-tuition">
              {formatAmountMinor(term.tuitionMinor)}
            </b>
          </div>
          <SecondaryAmount field="pool-tuition-second" minor={term.tuitionMinor} />
          <span class="muted small money">{t('dashboard.termStats', { sessions: term.sessionCount, hours: term.hours, rate: term.rateText })}</span>
        </div>
      ) : null}
      <span class="muted small">{t('dashboard.beforeFoot')}</span>
    </div>
  );
}

function AfterTerm({ model }: { model: DashboardModel }) {
  const term = model.term;
  return (
    <div class="card state-card">
      <span class="label">{t('dashboard.termSummary')}</span>
      <div class="hero-row">
        <span class="num accent hero-currency money">{getCurrency(model.currency).symbol}</span>
        <span class="num state-number money" data-field="pool-tuition">
          {formatAmountMinor(term?.tuitionMinor ?? 0)}
        </span>
      </div>
      <SecondaryAmount field="pool-tuition-second" minor={term?.tuitionMinor ?? 0} />
      {term ? (
        <>
          <span class="muted small money">{t('dashboard.termStats', { sessions: term.sessionCount, hours: term.hours, rate: term.rateText })}</span>
          <span class="muted small">
            {t('dashboard.termSlack', { minutes: minutesOf(term.slackSeconds) })} · {t('dashboard.slackWasted')} <Money minor={term.slackAmountMinor} currency={model.currency} />
          </span>
        </>
      ) : null}
      <span class="muted small">{t('dashboard.afterFoot')}</span>
      {demoActive.value ? null : (
        <div>
          <a class="btn btn--primary" id="share-link" href="#/stats">
            {t('dashboard.shareButton')}
          </a>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page

export function Dashboard() {
  const model = dashboardModel.value;
  const selectedId = selectedSessionId.value;
  const view = shownView(model, selectedId);
  const slacking = slackUi.value !== null;
  const school = activeConfig.value.school?.trim();
  const title = [school || t('app.title'), poolTitle(model)].filter(Boolean).join(' · ');

  let body;
  if (model.pools.length === 0) {
    body = <p class="muted">{t('dashboard.empty')}</p>;
  } else switch (model.kind) {
    case 'in-class':
      body = view ? <InClass model={model} view={view} /> : null;
      break;
    case 'break':
      body = <Break model={model} />;
      break;
    case 'done-today':
      body = <Today model={model} empty={false} />;
      break;
    case 'no-class-today':
      body = <Today model={model} empty />;
      break;
    case 'before-term':
      body = <BeforeTerm model={model} />;
      break;
    default:
      body = <AfterTerm model={model} />;
  }

  return (
    <div class="dashboard" id="dashboard" data-status={model.kind}>
      <header class="dash-topbar">
        <span class="topbar__title">{title}</span>
        <span class="grow" />
        <span class="pill" id="status-pill">
          <span class={`dot${model.kind === 'in-class' ? ' live' : ''}`} aria-hidden="true" />
          {t(STATUS_KEYS[model.kind])}
        </span>
      </header>
      <LiveSummary model={model} selectedId={selectedId} />
      <main class="dash-main">{body}</main>
      {model.kind === 'in-class' && view ? (
        <div class="dash-footer">
          <Button variant="primary" id="slack-btn" disabled={slacking} onClick={() => void startSlack(view.id, activeNow.peek())}>
            {t('dashboard.slackButton')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
