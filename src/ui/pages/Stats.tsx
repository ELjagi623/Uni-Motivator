// The statistics page: this week / this semester, a ranking of the courses, the dearest and the most "losing" class,
// slacking figures, a weekly cost chart (hand-written SVG, no chart library) and the share card.
// The page only displays what src/state/stats.ts (core's numbers, formatted) hands it.

import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { generateShareCard, shareBusy, shareError, shareResult } from '../../state/share';
import type { HighlightView, PeriodView } from '../../state/stats';
import { statsModel } from '../../state/statsState';
import { Button } from '../components/controls';

function PeriodCard({ view, id }: { view: PeriodView; id: string }) {
  return (
    <section class="card period-card" id={id} aria-label={view.label}>
      <span class="label">{view.label}</span>
      <b class="num period-spent money" data-field={`${id}-spent`}>
        {view.spentText}
      </b>
      <span class="muted small">{t('stats.spent')}</span>
      <dl class="period-facts">
        <div>
          <dt class="muted small">{t('stats.hours')}</dt>
          <dd class="num" data-field={`${id}-hours`}>
            {view.hoursText}
          </dd>
        </div>
        <div>
          <dt class="muted small">{t('stats.attendance')}</dt>
          <dd class="num" data-field={`${id}-attendance`}>
            {view.attendanceText}
          </dd>
        </div>
        <div class="wide">
          <dt class="muted small">{t('stats.slack')}</dt>
          <dd class="num money" data-field={`${id}-slack`}>
            {view.slackText}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Highlight({ title, view, id, empty }: { title: string; view: HighlightView | null; id: string; empty: string }) {
  return (
    <section class="card highlight-card" id={id}>
      <span class="label">{title}</span>
      {view ? (
        <>
          <span class="h2" data-field={`${id}-course`}>
            {t('stats.sessionLine', { course: view.courseLabel, date: view.dateText })}
          </span>
          <b class="num highlight-figure money" data-field={`${id}-cost`}>
            {view.costText}
          </b>
          <span class="muted small">
            {t('stats.slack')} <span class="money" data-field={`${id}-slack`}>{view.slackText}</span>
          </span>
        </>
      ) : (
        <p class="muted">{empty}</p>
      )}
    </section>
  );
}

function CoursesChart() {
  const m = statsModel.value;
  const chart = m.coursesChart;
  return (
    <section class="card" id="courses-card" aria-labelledby="courses-title">
      <span class="label" id="courses-title">
        {t('stats.courses')}
      </span>
      <svg class="chart chart--courses" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={t('stats.coursesAria')} id="courses-chart">
        {m.courses.map((c, i) => (
          <g key={c.courseId} data-course-id={c.courseId} style={{ '--i': i }}>
            <text class="chart__label" x="0" y={c.barY + 12}>
              {c.label}
            </text>
            <rect class="chart__bar chart__grow-x" x={chart.labelWidth} y={c.barY} width={c.barWidth} height="14" rx="4" />
            <text class="chart__value chart__fade money" x={chart.labelWidth + c.barWidth + 8} y={c.barY + 12}>
              {c.costText}
            </text>
          </g>
        ))}
      </svg>
      <table class="table stats-table" id="courses-table">
        <thead>
          <tr>
            <th scope="col">{t('stats.colCourse')}</th>
            <th scope="col">{t('stats.colCost')}</th>
            <th scope="col">{t('stats.colPerHour')}</th>
            <th scope="col">{t('stats.colAttendance')}</th>
            <th scope="col">{t('stats.colSlack')}</th>
          </tr>
        </thead>
        <tbody>
          {m.courses.map((c) => (
            <tr key={c.courseId} data-course-id={c.courseId}>
              <td class="c-course-name">
                <b>{c.label}</b>
                {c.subtitle ? <span class="muted small"> {c.subtitle}</span> : null}
              </td>
              <td class="num money" data-label={t('stats.colCost')} data-field="course-cost">
                {c.costText}
              </td>
              <td class="num money" data-label={t('stats.colPerHour')} data-field="course-per-hour">
                {c.perHourText}
              </td>
              <td class="num" data-label={t('stats.colAttendance')} data-field="course-attendance">
                {c.attendanceText}
              </td>
              <td class="num money" data-label={t('stats.colSlack')} data-field="course-slack">
                {c.slackText}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HistoryCard() {
  const h = statsModel.value.history;
  if (!h) return null;
  const rows = [...h.rows, h.total];
  return (
    <section class="card" id="history-card" aria-labelledby="history-title">
      <span class="label" id="history-title">
        {t('stats.history.title')}
      </span>
      <table class="table stats-table history-table" id="history-table" aria-label={t('stats.history.aria')}>
        <thead>
          <tr>
            <th scope="col">{t('stats.history.colYear')}</th>
            <th scope="col">{t('stats.colCost')}</th>
            <th scope="col">{t('stats.hours')}</th>
            <th scope="col">{t('stats.attendance')}</th>
            <th scope="col">{t('stats.colSlack')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.year ?? 'total'} data-year={r.year ?? 'total'} data-role={r.role ?? ''} class={r.year === null ? 'is-total' : ''}>
              <th scope="row" class="c-course-name">
                <b>{r.label}</b>
                {r.roleLabel ? <span class="muted small"> {r.roleLabel}</span> : null}
              </th>
              <td class="num money" data-label={t('stats.colCost')} data-field="history-cost">
                {r.costText}
              </td>
              <td class="num" data-label={t('stats.hours')} data-field="history-hours">
                {r.hoursText}
              </td>
              <td class="num" data-label={t('stats.attendance')} data-field="history-attendance">
                {r.attendanceText}
              </td>
              <td class="num money" data-label={t('stats.colSlack')} data-field="history-slack">
                {r.slackText}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SlackCard() {
  const s = statsModel.value.slack;
  return (
    <section class="card" id="slack-card" aria-labelledby="slack-title">
      <span class="label" id="slack-title">
        {t('stats.slackTitle')}
      </span>
      {s.hasSlack ? (
        <dl class="period-facts slack-facts">
          <div>
            <dt class="muted small">{t('stats.slackTotal')}</dt>
            <dd class="num money" data-field="slack-total">
              {s.totalText}
            </dd>
          </div>
          <div>
            <dt class="muted small">{t('stats.slackRate')}</dt>
            <dd class="num" data-field="slack-rate">
              {s.rateText}
            </dd>
          </div>
          <div class="wide">
            <dt class="muted small">{t('stats.slackFavourite')}</dt>
            <dd class="num money" data-field="slack-favourite">
              {s.favouriteText}
            </dd>
          </div>
          <div class="wide">
            <dt class="muted small">{t('stats.slackLongest')}</dt>
            <dd class="num money" data-field="slack-longest">
              {s.longestText}
            </dd>
          </div>
        </dl>
      ) : (
        <p class="muted" id="slack-none">
          {t('stats.slackNone')}
        </p>
      )}
    </section>
  );
}

function WeeklyChart() {
  const w = statsModel.value.weekly;
  const [hover, setHover] = useState<number | null>(null);
  const bar = hover !== null ? w.bars[hover] : undefined;
  return (
    <section class="card" id="weekly-card" aria-labelledby="weekly-title">
      <span class="label" id="weekly-title">
        {t('stats.weekly')}
      </span>
      <div class="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg class={`chart chart--weekly${bar ? ' is-hovering' : ''}`} viewBox={`0 0 ${w.width} ${w.height}`} role="img" aria-label={t('stats.weeklyAria')} id="weekly-chart">
          {w.ticks.map((tick) => (
            <g key={tick.y} class="chart__tick-row">
              <line class="chart__grid" x1={w.plotLeft} x2={w.plotRight} y1={tick.y} y2={tick.y} />
              <text class="chart__yvalue money" x={w.plotLeft - 8} y={tick.y + 4} text-anchor="end">
                {tick.label}
              </text>
            </g>
          ))}
          <line class="chart__axis" x1={w.plotLeft} x2={w.plotRight} y1={w.baseline} y2={w.baseline} />
          {w.bars.map((b, i) => (
            <g key={b.key} data-week-start={b.key} class={hover === i ? 'is-active' : undefined}>
              <g class="chart__grow-y" style={{ '--i': i, transformOrigin: `0 ${w.baseline}px` }}>
                <rect class="chart__bar" x={b.x} y={b.y} width={b.width} height={b.height} rx="3" />
                {b.slackHeight > 0 ? <rect class="chart__slack" x={b.x} y={b.slackY} width={b.width} height={b.slackHeight} rx="3" /> : null}
              </g>
              {b.tick ? (
                <text class="chart__tick" x={b.tickX} y={w.baseline + 18} text-anchor="middle">
                  {b.tick}
                </text>
              ) : null}
              <rect
                class="chart__hit"
                x={b.slotX}
                y={14}
                width={b.slotWidth}
                height={w.baseline - 14}
                tabIndex={0}
                aria-label={`${b.weekText} · ${b.costText}${b.slackText ? ` · ${t('stats.legendSlack')} ${b.slackText}` : ''}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          ))}
        </svg>
        {bar ? (
          <div class="chart-tip" id="weekly-tip" role="status" style={{ left: bar.tipLeft, top: bar.tipTop }}>
            <span class="muted small">{bar.weekText}</span>
            <b class="num money" data-field="weekly-tip-cost">
              {bar.costText}
            </b>
            {bar.slackText ? (
              <span class="small">
                {t('stats.legendSlack')} <span class="money">{bar.slackText}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div class="chart-legend small muted">
        <span>
          <i class="swatch swatch--cost" aria-hidden="true" /> {t('stats.legendCost')}
        </span>
        <span>
          <i class="swatch swatch--slack" aria-hidden="true" /> {t('stats.legendSlack')}
        </span>
      </div>
    </section>
  );
}

function SharePanel() {
  const result = shareResult.value;
  return (
    <section class="card share-panel" id="share-panel" aria-labelledby="share-title">
      <span class="label" id="share-title">
        {t('share.title')}
      </span>
      <p class="muted small">{t('share.hint')}</p>
      <div class="share-actions">
        <Button variant="primary" id="share-generate" disabled={shareBusy.value} onClick={() => void generateShareCard()}>
          {t('share.generate')}
        </Button>
        {result ? (
          <a class="btn" id="share-download" href={result.url} download={result.fileName}>
            {t('share.download')}
          </a>
        ) : null}
      </div>
      {shareError.value ? (
        <p class="field-error" role="alert" id="share-error">
          {shareError.value}
        </p>
      ) : null}
      {result ? <img class="share-preview money" id="share-preview" src={result.url} alt={t('share.previewAlt')} width="360" height="480" /> : null}
    </section>
  );
}

export function Stats() {
  const m = statsModel.value;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <div class="stats-page" id="stats">
      <div class="topbar page-topbar">
        <h1 class="topbar__title page-title" tabIndex={-1} ref={headingRef} id="page-title">
          {t('stats.title')}
        </h1>
        <span class="grow" />
      </div>
      <div class="stats-body">
        {m.hasData ? (
          <>
            <div class="stats-periods">
              {m.semester ? <PeriodCard view={m.semester} id="period-semester" /> : null}
              <PeriodCard view={m.week} id="period-week" />
            </div>
            <CoursesChart />
            <div class="stats-pair">
              <Highlight title={t('stats.expensive')} view={m.expensive} id="expensive" empty={t('stats.noLossy')} />
              <Highlight title={t('stats.lossy')} view={m.lossy} id="lossy" empty={t('stats.noLossy')} />
            </div>
            <SlackCard />
            <WeeklyChart />
            <HistoryCard />
          </>
        ) : (
          <p class="muted page-empty" role="status" id="stats-empty">
            {t('stats.empty')}
          </p>
        )}
        <SharePanel />
      </div>
    </div>
  );
}
