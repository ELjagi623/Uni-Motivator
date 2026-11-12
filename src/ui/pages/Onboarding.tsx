// The 7-step first-run wizard. The UI only shows the draft and collects input; counts, prices and the split-date
// check come from state / core.

import { useEffect, useRef, useState } from 'preact/hooks';
import { t, type MessageKey } from '../../i18n';
import { formatMinor, getCurrency } from '../../core/money';
import { CURRENCIES } from '../../data/currencies';
import { REGION_PRESETS } from '../../data/regions';
import { calendarSummaries, importFiles, importing, importReport, removeCalendar, type ImportFailureReason } from '../../state/calendars';
import { calendars } from '../../state/data';
import { enterDemo } from '../../state/demo';
import {
  TOTAL_STEPS,
  chooseRegion,
  draft,
  finishOnboarding,
  goToStep,
  isValidMonthDay,
  nextStep,
  preview,
  previousStep,
  stepAllowsNext,
  tuitionMinorOf,
  updateDraft,
  type BillingPeriod,
  type RegionId,
} from '../../state/onboarding';
import { Button, ChoiceGroup, StepBar, TextInput } from '../components/controls';
import { SplitChecks } from '../components/SplitChecks';
import { CourseRecognition } from './CourseRecognition';

const STEP_NAME_KEYS: Record<number, MessageKey> = {
  1: 'onboarding.step1.name',
  2: 'onboarding.step2.name',
  3: 'onboarding.step3.name',
  4: 'onboarding.step4.name',
  5: 'onboarding.step5.name',
  6: 'onboarding.step6.name',
  7: 'onboarding.step7.name',
};
const STEP_TITLE_KEYS: Record<number, MessageKey> = {
  1: 'onboarding.step1.title',
  2: 'onboarding.step2.title',
  3: 'onboarding.step3.title',
  4: 'onboarding.step4.title',
  5: 'onboarding.step5.title',
  6: 'onboarding.step6.title',
  7: 'onboarding.step7.title',
};
const STEP_HINT_KEYS: Record<number, MessageKey> = {
  1: 'onboarding.step1.hint',
  2: 'onboarding.step2.hint',
  3: 'onboarding.step3.hint',
  4: 'onboarding.step4.hint',
  5: 'onboarding.step5.hint',
  6: 'onboarding.step6.hint',
  7: 'onboarding.step7.hint',
};

function periodOptions() {
  return [
    { value: 'semester' as const, label: t('onboarding.period.semester') },
    { value: 'year' as const, label: t('onboarding.period.year') },
  ];
}

// ------------------------------------------------------------------ steps

function StepRegion() {
  const d = draft.value;
  return (
    <div class="step-body">
      <div class="field-group">
        <label class="label" for="school-input">
          {t('onboarding.step1.schoolLabel')}
        </label>
        <div class="field">
          <TextInput id="school-input" value={d.school} label={t('onboarding.step1.schoolLabel')} placeholder={t('onboarding.step1.schoolPlaceholder')} onInput={(v) => updateDraft({ school: v })} />
        </div>
      </div>
      <div class="field-group">
        <span class="label">{t('onboarding.step1.regionLabel')}</span>
        <ChoiceGroup<RegionId>
          name="region"
          legend={t('onboarding.step1.regionLabel')}
          variant="chip"
          value={d.region}
          options={REGION_PRESETS.map((r) => ({ value: r.id, label: t(`region.${r.id}` as const) }))}
          onChange={chooseRegion}
        />
        <p class="muted small option-note">{t('onboarding.step1.regionNote')}</p>
      </div>
    </div>
  );
}

function StepPeriod() {
  const d = draft.value;
  return (
    <div class="step-body">
      <ChoiceGroup<BillingPeriod> name="period" legend={t('onboarding.step3.periodLabel')} variant="seg" value={d.billingPeriod} options={periodOptions()} onChange={(v) => updateDraft({ billingPeriod: v })} />
      <p class="muted option-note">{d.billingPeriod === 'semester' ? t('onboarding.step2.semesterNote') : t('onboarding.step2.yearNote')}</p>
    </div>
  );
}

function StepTuition() {
  const d = draft.value;
  const minor = tuitionMinorOf(d);
  const typed = d.tuitionText.trim() !== '';
  const invalid = typed && minor === null;
  const perSemester = d.billingPeriod === 'semester';
  return (
    <div class="step-body">
      <div class="form-row">
        <span class="label">{t('onboarding.step3.periodLabel')}</span>
        <ChoiceGroup<BillingPeriod> name="period-3" legend={t('onboarding.step3.periodLabel')} variant="seg" value={d.billingPeriod} options={periodOptions()} onChange={(v) => updateDraft({ billingPeriod: v })} />
      </div>
      <div class="form-row">
        <span class="label">{t('onboarding.step3.currencyLabel')}</span>
        <ChoiceGroup
          name="currency"
          legend={t('onboarding.step3.currencyLabel')}
          variant="chip"
          value={d.currency}
          options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))}
          onChange={(v) => updateDraft({ currency: v })}
        />
      </div>
      <div class="field-group">
        <label class="label" for="tuition-input">
          {perSemester ? t('onboarding.step3.tuitionSemester') : t('onboarding.step3.tuitionYear')}
        </label>
        <div class={`field field--hero${invalid ? ' field--invalid' : ''}`}>
          <span class="num accent hero-currency" aria-hidden="true">
            {getCurrency(d.currency).symbol}
          </span>
          <TextInput
            id="tuition-input"
            className="num"
            value={d.tuitionText}
            inputMode="decimal"
            placeholder="0"
            invalid={invalid}
            describedBy="tuition-hint"
            label={perSemester ? t('onboarding.step3.tuitionSemester') : t('onboarding.step3.tuitionYear')}
            onInput={(v) => updateDraft({ tuitionText: v })}
          />
          <span class="muted">{perSemester ? t('onboarding.step3.suffixSemester') : t('onboarding.step3.suffixYear')}</span>
        </div>
        <p id="tuition-hint" class={invalid ? 'field-error' : 'muted small'} role={invalid ? 'alert' : undefined}>
          {invalid ? t('onboarding.step3.invalid') : minor !== null ? t('onboarding.step3.asAmount', { amount: formatMinor(minor, d.currency) }) : perSemester ? t('onboarding.step3.helpSemester') : t('onboarding.step3.helpYear')}
        </p>
      </div>
    </div>
  );
}

function StepDates() {
  const d = draft.value;
  const startBad = !isValidMonthDay(d.yearStart);
  const splitBad = !isValidMonthDay(d.splitDate);
  return (
    <div class="step-body">
      <div class="form-row--two">
        <div class="field-group">
          <label class="label" for="year-start-input">
            {t('onboarding.step4.yearStart')}
          </label>
          <div class={`field${startBad ? ' field--invalid' : ''}`}>
            <TextInput id="year-start-input" className="num" value={d.yearStart} placeholder="MM-DD" maxLength={5} inputMode="numeric" invalid={startBad} label={t('onboarding.step4.yearStart')} onInput={(v) => updateDraft({ yearStart: v })} />
          </div>
        </div>
        <div class="field-group">
          <label class="label" for="split-date-input">
            {t('onboarding.step4.splitDate')}
          </label>
          <div class={`field${splitBad ? ' field--invalid' : ''}`}>
            <TextInput id="split-date-input" className="num" value={d.splitDate} placeholder="MM-DD" maxLength={5} inputMode="numeric" invalid={splitBad} label={t('onboarding.step4.splitDate')} onInput={(v) => updateDraft({ splitDate: v })} />
          </div>
        </div>
      </div>
      {startBad || splitBad ? (
        <p class="field-error" role="alert">
          {t('onboarding.step4.invalid')}
        </p>
      ) : (
        <p class="muted small option-note">{t('onboarding.step4.help')}</p>
      )}
    </div>
  );
}

const FAILURE_KEYS: Record<ImportFailureReason, MessageKey> = {
  unsupported: 'onboarding.step5.errUnsupported',
  'not-calendar': 'onboarding.step5.errNotCalendar',
  'no-ics': 'onboarding.step5.errNoIcs',
  upload: 'onboarding.step5.errUpload',
};

async function handleFiles(files: FileList | File[] | null): Promise<void> {
  if (!files || files.length === 0) return;
  const items = await Promise.all(Array.from(files).map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
  await importFiles(items);
}

function StepImport() {
  const [over, setOver] = useState(false);
  const summaries = calendarSummaries.value;
  const report = importReport.value;
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void handleFiles(event.dataTransfer?.files ?? null);
  };
  return (
    <div class="step-body">
      <div
        class={`dropzone${over ? ' is-over' : ''}`}
        id="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
        </svg>
        <strong>{over ? t('onboarding.step5.dropActive') : t('onboarding.step5.dropTitle')}</strong>
        <span class="muted small">{t('onboarding.step5.dropOr')}</span>
        <label class="btn btn--ghost">
          <input
            class="sr-only"
            id="calendar-file-input"
            type="file"
            multiple
            accept=".zip,.ics,application/zip,text/calendar"
            onChange={(e) => {
              const input = e.currentTarget as HTMLInputElement;
              void handleFiles(input.files).then(() => {
                input.value = '';
              });
            }}
          />
          {t('onboarding.step5.choose')}
        </label>
      </div>
      <div role="status" aria-live="polite">
        {importing.value ? <p class="muted">{t('onboarding.step5.importing')}</p> : null}
        {report ? (
          <ul class="report">
            {report.added > 0 ? <li>{t('onboarding.step5.added', { n: report.added })}</li> : null}
            {report.duplicates.map((name) => (
              <li key={`dup-${name}`}>{t('onboarding.step5.duplicate', { name })}</li>
            ))}
            {report.failures.map((f) => (
              <li class="is-error" key={`fail-${f.name}`}>
                {t(FAILURE_KEYS[f.reason], { name: f.name, message: f.message ?? '' })}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {summaries.length > 0 ? (
        <div class="field-group">
          <span class="label">{t('onboarding.step5.listTitle')}</span>
          <ul class="calendar-list" id="calendar-list">
            {summaries.map((s) => (
              <li key={s.id} data-calendar-id={s.id}>
                <span class="grow calendar-list__name">{s.name}</span>
                <span class="muted small">{s.failed ? t('onboarding.step5.unreadable') : s.sessionCount === 0 ? t('onboarding.step5.noEvents') : t('onboarding.step5.eventCount', { n: s.sessionCount })}</span>
                <Button small variant="ghost" onClick={() => void removeCalendar(s.id)}>
                  {t('onboarding.step5.remove')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p class="muted small">{t('onboarding.step5.needOne')}</p>
      )}
    </div>
  );
}

function StepPreview() {
  const p = preview.value;
  const d = draft.value;
  if (p.sessionCount === 0) {
    return (
      <div class="step-body" role="alert">
        <p>{t('onboarding.step7.noSessions')}</p>
        <div>
          <Button variant="primary" onClick={() => goToStep(6)}>
            {t('onboarding.step7.backToRecognition')}
          </Button>
        </div>
      </div>
    );
  }
  if (tuitionMinorOf(d) === null) {
    return (
      <div class="step-body" role="alert">
        <p>{t('onboarding.step7.noTuition')}</p>
        <div>
          <Button variant="primary" onClick={() => goToStep(3)}>
            {t('onboarding.step7.backToTuition')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div class="step-body">
      <section class="preview" aria-label={t('onboarding.step7.title')} id="preview">
        <div class="preview__hero">
          <span class="label">{t('onboarding.step7.rateLabel')}</span>
          <span class="num hero-number" id="preview-rate">
            {p.rate}
          </span>
          <p class="muted">
            {t('onboarding.step7.totals', { sessions: p.sessionCount, hours: p.hours })} · {t('onboarding.step7.average', { amount: p.average ?? '' })}
          </p>
        </div>
        <ul class="pool-table" id="preview-pools">
          {p.pools.map((pool) => (
            <li key={pool.key} data-pool-key={pool.key}>
              <span>{pool.semester === null ? t('onboarding.step7.poolYear', { year: pool.year }) : t('onboarding.step7.poolSemester', { year: pool.year, n: pool.semester })}</span>
              <span>
                <b class="num">{pool.sessions}</b> {t('unit.sessions')}
              </span>
              <span>
                <b class="num">{pool.hours}</b> {t('unit.hours')}
              </span>
              <span>
                {t('onboarding.step7.rateShort')} <b class="num">{pool.rate}</b>
              </span>
              <span>
                {t('onboarding.step7.averageShort')} <b class="num">{pool.average}</b>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {p.splitChecks.length > 0 ? (
        <div class="field-group">
          <span class="label">{t('onboarding.step7.splitTitle')}</span>
          <SplitChecks checks={p.splitChecks} id="split-checks" onAdopt={(suggest) => updateDraft({ splitDate: suggest })} />
        </div>
      ) : null}
    </div>
  );
}

function renderStep(step: number) {
  switch (step) {
    case 1:
      return <StepRegion />;
    case 2:
      return <StepPeriod />;
    case 3:
      return <StepTuition />;
    case 4:
      return <StepDates />;
    case 5:
      return <StepImport />;
    case 6:
      return <CourseRecognition />;
    default:
      return <StepPreview />;
  }
}

function FooterPreview() {
  const p = preview.value;
  if (p.sessionCount === 0) return <span class="grow" />;
  return (
    <div class="footer-preview grow" id="footer-preview">
      <span class="label">{t('onboarding.step6.previewLabel')}</span>
      <span>
        <b class="num">{p.sessionCount}</b> {t('unit.sessions')} · <b class="num">{p.hours}</b> {t('unit.hours')}
        {p.rate ? (
          <>
            {' '}
            · {t('onboarding.step7.rateShort')} <b class="num accent">{p.rate}</b>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function Onboarding() {
  const d = draft.value;
  const step = d.step;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const [finishing, setFinishing] = useState(false);

  // Move focus to the new step's heading so keyboard and screen-reader users continue from the top.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const finish = async () => {
    setFinishing(true);
    try {
      await finishOnboarding();
    } finally {
      setFinishing(false);
    }
  };

  const isLast = step === TOTAL_STEPS;
  return (
    <div class="panel" id="onboarding">
      <div class="topbar">
        <span class="topbar__title">{t('app.title')}</span>
        <span class="muted grow">{t('onboarding.setup')}</span>
        <span class="label" id="step-counter">
          {t('onboarding.stepOfTotal', { n: step, total: TOTAL_STEPS })}
        </span>
      </div>
      <div class="panel__body">
        <StepBar current={step} total={TOTAL_STEPS} />
        <header class="step-head">
          <span class="label">{t('onboarding.stepLabel', { n: step, name: t(STEP_NAME_KEYS[step]) })}</span>
          <h1 class="h1" tabIndex={-1} ref={headingRef} id="step-title">
            {t(STEP_TITLE_KEYS[step])}
          </h1>
          <p class="muted">{t(STEP_HINT_KEYS[step])}</p>
        </header>
        {renderStep(step)}
      </div>
      <div class="panel__footer">
        {step === 6 ? <FooterPreview /> : null}
        {step <= 5 ? (
          <Button variant="ghost" small id="demo-btn" onClick={enterDemo}>
            {t('demo.start')}
          </Button>
        ) : null}
        <div class="panel__footer-buttons">
          <Button variant="ghost" id="prev-btn" disabled={step === 1} onClick={previousStep}>
            {t('onboarding.prev')}
          </Button>
          {isLast ? (
            <Button variant="primary" id="finish-btn" disabled={!stepAllowsNext.value || finishing || calendars.value.length === 0} onClick={() => void finish()}>
              {t('onboarding.finish')}
            </Button>
          ) : (
            <Button variant="primary" id="next-btn" disabled={!stepAllowsNext.value} onClick={nextStep}>
              {t('onboarding.next')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
