// The session list: one week at a time, with the three summary figures and a detail panel to mark a class as skipped
// (翘课) or cancelled by the school (停课). The page only displays what state/core produced; the figures and the
// marks are written by src/state. Status is never shown by colour alone: every tag carries a glyph and a word.

import { useEffect, useRef, useState } from 'preact/hooks';
import { t, type MessageKey } from '../../i18n';
import { removeOccurrence, cancelManual } from '../../state/manual';
import { setLateEarly, setMark, type LateKind } from '../../state/marks';
import { type SessionRow } from '../../state/sessions';
import { goNextWeek, goPrevWeek, goThisWeek, goToYear, selectRow, selectedRow, selectedRowId, sessionsModel } from '../../state/sessionsState';
import { Button, TextInput } from '../components/controls';
import { ManualPanel } from './ManualPanel';

const PHASE_KEYS: Record<SessionRow['phase'], MessageKey> = {
  past: 'sessions.tag.past',
  ongoing: 'sessions.tag.ongoing',
  upcoming: 'sessions.tag.upcoming',
};

/** The status tag of a row: the mark when there is one, otherwise where the class is in time. */
function StatusTag({ row }: { row: SessionRow }) {
  if (row.mark === 'skipped') return <span class="tag tag--skip" data-status="skipped">{t('sessions.tag.skipped')}</span>;
  if (row.mark === 'cancelled') return <span class="tag tag--cancel" data-status="cancelled">{t('sessions.tag.cancelled')}</span>;
  return (
    <span class={`tag tag--${row.phase}`} data-status={row.phase}>
      {t(PHASE_KEYS[row.phase])}
    </span>
  );
}

/** Minutes arrived late / left early for one class, with the money they cost. Refused values show the reason and are not saved. */
function LateEarly({ row }: { row: SessionRow }) {
  const [text, setText] = useState<Record<LateKind, string>>({ late: row.lateMin > 0 ? String(row.lateMin) : '', early: row.earlyMin > 0 ? String(row.earlyMin) : '' });
  const [bad, setBad] = useState<Record<LateKind, boolean>>({ late: false, early: false });
  if (row.mark !== null) {
    return (
      <p class="muted small" id="late-none">
        {t('late.notAttended')}
      </p>
    );
  }
  const change = (kind: LateKind, value: string) => {
    setText((cur) => ({ ...cur, [kind]: value }));
    const result = setLateEarly(row.id, kind, value);
    setBad((cur) => ({ ...cur, [kind]: result === 'invalid' }));
  };
  const fields: Array<{ kind: LateKind; label: string; aria: string; loss: string; minutes: number }> = [
    { kind: 'late', label: t('late.late'), aria: t('late.lateAria'), loss: row.lateLossText, minutes: row.lateMin },
    { kind: 'early', label: t('late.early'), aria: t('late.earlyAria'), loss: row.earlyLossText, minutes: row.earlyMin },
  ];
  return (
    <div class="late-early" id="late-early-box">
      <span class="label">{t('late.title')}</span>
      {fields.map((f) => (
        <div key={f.kind} class="late-early__row">
          <label class="muted" for={`late-${f.kind}`}>
            {f.label}
          </label>
          <TextInput id={`late-${f.kind}`} className="num late-input" value={text[f.kind]} inputMode="numeric" maxLength={4} placeholder="0" invalid={bad[f.kind]} label={f.aria} describedBy={bad[f.kind] ? 'late-error' : undefined} onInput={(v) => change(f.kind, v)} />
          {f.minutes > 0 ? (
            <span class="muted small money" data-field={`${f.kind}-loss`}>
              {t('late.loss', { amount: f.loss })}
            </span>
          ) : null}
        </div>
      ))}
      {bad.late || bad.early ? (
        <p class="field-error" role="alert" id="late-error">
          {t('late.invalid', { max: row.durationMin })}
        </p>
      ) : null}
    </div>
  );
}

function SummaryCards() {
  const s = sessionsModel.value.summary;
  return (
    <section class="summary-row" aria-label={t('sessions.title')}>
      <div class="card summary-card">
        <span class="label">{t('sessions.cancelledLabel')}</span>
        <b class="num summary-figure money" data-field="cancelled-amount">
          {s.cancelledText}
        </b>
      </div>
      <div class="card summary-card">
        <span class="label">{t('sessions.skippedLabel')}</span>
        <b class="num summary-figure summary-figure--loss money" data-field="skipped-amount">
          {s.skippedText}
        </b>
      </div>
      <div class="card summary-card">
        <span class="label">{t('sessions.lateEarlyLabel')}</span>
        <b class="num summary-figure money" data-field="late-early-amount">
          {s.lateEarlyText}
        </b>
      </div>
      <div class="card summary-card">
        <span class="label">{t('sessions.attendanceLabel')}</span>
        <b class="num summary-figure" data-field="attendance-rate">
          {s.attendanceText}
        </b>
      </div>
    </section>
  );
}

function Row({ row, selected }: { row: SessionRow; selected: boolean }) {
  return (
    <tr
      class={`session-row${selected ? ' is-selected' : ''}${row.mark ? ` is-${row.mark}` : ''}`}
      data-session-id={row.id}
      data-phase={row.phase}
      data-mark={row.mark ?? ''}
      onClick={() => selectRow(row.id)}
    >
      <td class="c-date">{row.dateText}</td>
      <td class="c-time num">{row.timeText}</td>
      <td class="c-course">
        <button
          type="button"
          class="row-btn"
          aria-pressed={selected}
          aria-label={t('sessions.selectAria', { course: row.label, date: row.dateText, time: row.timeText })}
          onClick={(event) => {
            event.stopPropagation();
            selectRow(row.id);
          }}
        >
          {row.label}
        </button>
        {row.slackText ? (
          <span class="muted small row-slack money" data-field="row-slack">
            {row.slackText}
          </span>
        ) : null}
      </td>
      <td class="c-status">
        <StatusTag row={row} />
      </td>
      <td class="c-cost num money" data-label={t('sessions.colCost')}>
        {row.costText}
      </td>
    </tr>
  );
}

function SessionTable() {
  const model = sessionsModel.value;
  const selected = selectedRowId.value;
  if (model.rows.length === 0) {
    return (
      <div class="card sessions-list">
        <p class="muted" role="status" id="week-empty">
          {t('sessions.empty')}
        </p>
      </div>
    );
  }
  return (
    <div class="card sessions-list">
      <table class="table" id="session-table" aria-label={t('sessions.listAria')}>
        <thead>
          <tr>
            <th scope="col">{t('sessions.colDate')}</th>
            <th scope="col">{t('sessions.colTime')}</th>
            <th scope="col">{t('sessions.colCourse')}</th>
            <th scope="col">{t('sessions.colStatus')}</th>
            <th scope="col">{t('sessions.colCost')}</th>
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => (
            <Row key={row.id} row={row} selected={row.id === selected} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail() {
  const row = selectedRow.value;
  if (!row) {
    return (
      <aside class="card detail detail--empty" id="session-detail" aria-label={t('sessions.detail.title')}>
        <span class="label">{t('sessions.detail.title')}</span>
        <p class="muted" id="detail-empty">
          {t('sessions.detail.none')}
        </p>
      </aside>
    );
  }
  const skipped = row.mark === 'skipped';
  const cancelled = row.mark === 'cancelled';
  const stateKey: MessageKey = skipped ? 'sessions.state.skipped' : cancelled ? 'sessions.state.cancelled' : 'sessions.state.none';
  return (
    <aside class="card detail" id="session-detail" aria-label={t('sessions.detail.title')} data-session-id={row.id}>
      <div class="detail__head">
        <span class="label">{t('sessions.detail.title')}</span>
        <Button small variant="ghost" id="detail-close" onClick={() => selectRow(null)}>
          {t('sessions.detail.close')}
        </Button>
      </div>
      <span class="h2" data-field="detail-title">
        {row.detailTitle}
      </span>
      <span class="muted small" data-field="detail-sub">
        {row.ordinal ? t('sessions.detail.ordinal', { i: row.ordinal.index, n: row.ordinal.total, length: row.lengthText }) : row.lengthText}
        {' · '}
        <StatusTag row={row} />
      </span>
      <dl class="detail-facts">
        <div>
          <dt class="muted small">{t('sessions.detail.cost')}</dt>
          <dd class="num money" data-field="detail-cost">
            {row.fullCostText}
          </dd>
        </div>
        <div>
          <dt class="muted small">{t('sessions.detail.consumed')}</dt>
          <dd class="num money" data-field="detail-consumed">
            {row.costText}
          </dd>
        </div>
        <div>
          <dt class="muted small">{t('sessions.detail.rate')}</dt>
          <dd class="num money" data-field="detail-rate">
            {row.rateText}
          </dd>
        </div>
      </dl>
      {row.slackText ? <span class="muted small money">{row.slackText}</span> : null}
      <div class="mark-buttons" role="group" aria-label={t('sessions.detail.title')}>
        <Button variant="danger" id="mark-skip" pressed={skipped} disabled={row.readOnly} onClick={() => setMark(row.id, skipped ? null : 'skipped')}>
          {skipped ? t('sessions.unmarkSkip') : t('sessions.markSkip')}
        </Button>
        <Button variant="ghost" id="mark-cancel" pressed={cancelled} disabled={row.readOnly} onClick={() => setMark(row.id, cancelled ? null : 'cancelled')}>
          {cancelled ? t('sessions.unmarkCancel') : t('sessions.markCancel')}
        </Button>
      </div>
      <LateEarly key={row.id} row={row} />
      {row.isManual && !row.readOnly ? (
        <div class="manual-remove">
          <Button small variant="ghost" id="manual-remove-this" onClick={() => removeOccurrence(row.id, row.startMs)}>
            {t('manual.removeThis')}
          </Button>
        </div>
      ) : null}
      <p class="mark-state" id="mark-state" role="status">
        {t(stateKey)}
      </p>
      {row.readOnly ? (
        <p class="muted small readonly-note" id="readonly-note">
          <span class="tag tag--archived">{t('years.role.archived')}</span> {t('years.readOnlyNote')}
        </p>
      ) : null}
      {row.skipText ? (
        <div class="card inset calc-card" id="skip-calc">
          <span class="label">{t('sessions.calc.label')}</span>
          <p class="calc-text money" data-field="skip-calc">
            {row.skipText}
          </p>
        </div>
      ) : null}
    </aside>
  );
}

function YearChips() {
  const years = sessionsModel.value.years;
  if (years.length === 0) return null;
  return (
    <div class="year-chips" id="year-chips" role="group" aria-label={t('years.chipsAria')}>
      {years.map((y) => (
        <button
          key={y.year}
          type="button"
          class={`chip year-chip${y.active ? ' is-active' : ''}`}
          data-year={y.year}
          data-role={y.role}
          aria-pressed={y.active}
          onClick={() => goToYear(y.year)}
        >
          {y.label}
          {y.role === 'archived' ? <span class="year-chip__tag"> · {t('years.role.archived')}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Sessions() {
  const model = sessionsModel.value;
  const [adding, setAdding] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <div class={`sessions-page${selectedRowId.value !== null ? ' has-selection' : ''}`} id="sessions">
      <div class="topbar page-topbar">
        <h1 class="topbar__title page-title" tabIndex={-1} ref={headingRef} id="page-title">
          {t('sessions.title')}
        </h1>
        {model.hasSessions ? (
          <span class="muted grow" id="week-label" data-field="week-label">
            {model.weekLabel}
          </span>
        ) : (
          <span class="grow" />
        )}
        {model.hasSessions ? (
          <div class="week-nav">
            <Button variant="ghost" id="manual-open" pressed={adding} onClick={() => setAdding((on) => !on)}>
              {t('manual.add')}
            </Button>
            <Button variant="ghost" id="week-prev" disabled={!model.canPrev} onClick={goPrevWeek}>
              {t('sessions.prevWeek')}
            </Button>
            <Button variant="ghost" id="week-next" disabled={!model.canNext} onClick={goNextWeek}>
              {t('sessions.nextWeek')}
            </Button>
            {!model.isCurrentWeek ? (
              <Button variant="ghost" id="week-today" onClick={goThisWeek}>
                {t('sessions.thisWeek')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {adding ? (
        <div class="manual-wrap">
          <ManualPanel
            onClose={() => {
              cancelManual();
              setAdding(false);
            }}
          />
        </div>
      ) : null}
      {model.hasSessions ? (
        <>
          <YearChips />
          <SummaryCards />
          <p class="muted small summary-note" data-field="summary-scope">
            {sessionsModel.value.summaryScopeText ? `${sessionsModel.value.summaryScopeText} · ` : ''}
            {t('sessions.summaryNote')}
          </p>
          <div class="sessions-body">
            <SessionTable />
            <Detail />
          </div>
        </>
      ) : (
        <p class="muted page-empty" role="status">
          {t('sessions.noSessions')}
        </p>
      )}
      {!model.hasSessions && !adding ? (
        <div class="manual-wrap">
          <Button variant="ghost" id="manual-open-empty" onClick={() => setAdding(true)}>
            {t('manual.add')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
