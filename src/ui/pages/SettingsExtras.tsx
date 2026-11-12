// The settings cards added in P4b: appearance (theme), billing mode + credits, second currency, academic years.
// Like the rest of the settings page this only shows what src/state hands it and collects input.

import { getCurrency, type CurrencyCode } from '../../core/money';
import { CURRENCIES } from '../../data/currencies';
import { t, type MessageKey } from '../../i18n';
import { DEFAULT_CURRENCY, THEME_CHOICES, type ThemeChoice } from '../../state/config';
import { readImportItems, type ImportFailureReason } from '../../state/calendars';
import {
  RATES_DATE,
  editRateText,
  hasRateOverrides,
  rateDraft,
  rateDraftInvalid,
  rateFieldText,
  rateOverrides,
  resetRates,
  savedPrimary,
  secondaryCurrency,
  setSecondaryCurrency,
} from '../../state/currency';
import { cancelNewYear, confirmNewYear, newYear, newYearBusy, newYearPlan, newYearReport, newYearResult, setNewGroupCredits, setNewGroupName, setNewGroupSelected, setNewPoolTuition, startNewYear } from '../../state/newYear';
import { rateChangeText, setBillingMode, setCreditText, settingsView } from '../../state/settings';
import { setTheme, themeChoice } from '../../state/theme';
import { yearViews } from '../../state/years';
import { Button, ChoiceGroup, TextInput } from '../components/controls';
import { FileButton } from '../components/FileButton';
import { CourseList } from './CourseRecognition';
import type { BillingMode } from '../../core/types';

const FAILURE_KEYS: Record<ImportFailureReason, MessageKey> = {
  unsupported: 'onboarding.step5.errUnsupported',
  'not-calendar': 'onboarding.step5.errNotCalendar',
  'no-ics': 'onboarding.step5.errNoIcs',
  upload: 'onboarding.step5.errUpload',
};

// ------------------------------------------------------------------ appearance

export function AppearanceCard() {
  const options = THEME_CHOICES.map((value) => ({ value, label: t(`settings.theme.${value}` as const) }));
  return (
    <section class="card settings-card" id="card-appearance" aria-labelledby="appearance-title">
      <span class="label" id="appearance-title">
        {t('settings.appearance')}
      </span>
      <div class="row-between settings-row">
        <span>{t('settings.theme')}</span>
        <ChoiceGroup<ThemeChoice> name="settings-theme" legend={t('settings.theme')} variant="seg" value={themeChoice.value} options={options} onChange={setTheme} />
      </div>
      <p class="muted small">{t('settings.themeNote')}</p>
    </section>
  );
}

// ------------------------------------------------------------------ billing mode and credits

export function BillingModeCard() {
  const view = settingsView.value;
  const mode = view.draft.billingMode;
  const options = [
    { value: 'duration' as const, label: t('settings.mode.duration') },
    { value: 'credit' as const, label: t('settings.mode.credit') },
  ];
  return (
    <section class="card settings-card" id="card-mode" aria-labelledby="mode-title">
      <span class="label" id="mode-title">
        {t('settings.mode.title')}
      </span>
      <ChoiceGroup<BillingMode> name="settings-mode" legend={t('settings.mode.legend')} variant="seg" value={mode} options={options} onChange={setBillingMode} />
      <p class="muted small" id="mode-note">
        {mode === 'credit' ? t('settings.mode.creditNote') : t('settings.mode.durationNote')}
      </p>
      <p class="muted small">{t('settings.mode.switchNote')}</p>
      <span class="label" id="credits-title">
        {t('settings.credits.title')}
      </span>
      {view.courses.length === 0 ? (
        <p class="muted small">{t('settings.credits.none')}</p>
      ) : (
        <ul class="pool-fields credit-fields" id="credit-fields" aria-labelledby="credits-title">
          {view.courses.map((c) => (
            <li key={c.id} data-course-id={c.id}>
              <div class={`field${c.invalid ? ' field--invalid' : ''}`}>
                <label class="credit-label" for={`credit-${c.id}`}>
                  <b>{c.label}</b>
                  {c.subtitle ? <span class="muted small"> {c.subtitle}</span> : null}
                </label>
                <span class="grow" />
                <TextInput
                  id={`credit-${c.id}`}
                  className="num credit-input"
                  value={c.text}
                  inputMode="decimal"
                  maxLength={5}
                  placeholder={t('onboarding.step6.colCredits')}
                  invalid={c.invalid}
                  describedBy={c.invalid ? `credit-error-${c.id}` : undefined}
                  label={t('settings.credits.aria', { name: c.label })}
                  onInput={(v) => setCreditText(c.id, v)}
                />
              </div>
              {c.invalid ? (
                <p class="field-error" role="alert" id={`credit-error-${c.id}`}>
                  {t('settings.credits.invalid')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p class="muted small">{t('settings.credits.hint')}</p>
    </section>
  );
}

// ------------------------------------------------------------------ second currency

export function ExchangeCard() {
  const primary = savedPrimary.value;
  const second = secondaryCurrency.value;
  const options: Array<{ value: CurrencyCode | 'off'; label: string }> = [
    { value: 'off', label: t('settings.second.off') },
    ...CURRENCIES.filter((c) => c.code !== primary).map((c) => ({ value: c.code, label: c.code })),
  ];
  const invalid = rateDraftInvalid.value;
  const shown = rateDraft.value ?? (second ? rateFieldText(primary, second, rateOverrides.value) : '');
  return (
    <section class="card settings-card" id="card-exchange" aria-labelledby="exchange-title">
      <span class="label" id="exchange-title">
        {t('settings.second.title')}
      </span>
      <div class="field-group">
        <span>{t('settings.second.label')}</span>
        <ChoiceGroup<CurrencyCode | 'off'>
          name="settings-second"
          legend={t('settings.second.label')}
          variant="chip"
          value={second ?? 'off'}
          options={options}
          onChange={(v) => setSecondaryCurrency(v === 'off' ? null : v)}
        />
      </div>
      {second ? (
        <div class="field-group" id="rate-group">
          <div class={`field${invalid ? ' field--invalid' : ''}`}>
            <label class="muted" for="exchange-rate">
              {t('settings.second.rate')} · {t('settings.second.rateLead', { from: primary })}
            </label>
            <span class="grow" />
            <TextInput
              id="exchange-rate"
              className="num rate-input"
              value={shown}
              inputMode="decimal"
              invalid={invalid}
              describedBy="exchange-rate-note"
              label={t('settings.second.rateAria', { from: primary, to: second })}
              onInput={(v) => void editRateText(v)}
            />
            <span class="num muted" aria-hidden="true">
              {second}
            </span>
          </div>
          <p id="exchange-rate-note" class={invalid ? 'field-error' : 'muted small'} role={invalid ? 'alert' : undefined}>
            {invalid ? t('settings.second.invalid') : getCurrency(second).name}
          </p>
          {hasRateOverrides.value ? (
            <p class="muted small" id="rates-custom">
              {t('settings.second.custom')}{' '}
              <Button small variant="ghost" id="rates-reset" onClick={resetRates}>
                {t('settings.second.reset')}
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}
      <p class="muted small" id="rates-updated" data-date={RATES_DATE}>
        {t('settings.second.updated', { date: RATES_DATE })}
      </p>
      <p class="muted small">{t('settings.second.note')}</p>
    </section>
  );
}

// ------------------------------------------------------------------ academic years

function NewYearPanel() {
  const flow = newYear.value;
  const plan = newYearPlan.value;
  if (!flow || !plan) return null;
  const symbol = getCurrency(plan.candidate.currency ?? DEFAULT_CURRENCY).symbol;
  const known = (plan.candidate.courses ?? []).length - plan.newCourses.length;
  return (
    <div class="card inset new-year" id="new-year-panel" role="region" aria-labelledby="new-year-title">
      <span class="h2" id="new-year-title">
        {t('newYear.title')}
      </span>
      <p class="muted small" id="new-year-intro">
        {t('newYear.intro', { sessions: plan.newSessionCount })}
      </p>
      <span class="label">{t('newYear.courses')}</span>
      {plan.groups.length === 0 ? (
        <p class="muted small" id="new-year-no-courses">
          {t('newYear.noNewCourses')}
        </p>
      ) : (
        <CourseList
          idPrefix="newyear"
          groups={plan.groups}
          colorOffset={known}
          isOn={plan.isSelected}
          nameOf={(g) => flow.names[g.key] ?? g.name}
          creditsOf={(g) => flow.credits[g.key] ?? ''}
          onSelect={setNewGroupSelected}
          onName={setNewGroupName}
          onCredits={setNewGroupCredits}
        />
      )}
      {plan.groups.length > 0 && plan.newCourses.length === 0 && !plan.canConfirm ? (
        <p class="field-error" role="alert" id="new-year-need-course">
          {t('newYear.needCourse')}
        </p>
      ) : null}
      {plan.newPools.length > 0 ? (
        <>
          <span class="label">{t('newYear.tuition')}</span>
          <ul class="pool-fields" id="new-year-pools">
            {plan.newPools.map((pool) => (
              <li key={pool.key} data-pool-key={pool.key}>
                <div class={`field${pool.invalid ? ' field--invalid' : ''}`}>
                  <label class="muted" for={`new-pool-${pool.key}`}>
                    {pool.label}
                  </label>
                  <span class="grow" />
                  <span class="num muted money" aria-hidden="true">
                    {symbol}
                  </span>
                  <TextInput
                    id={`new-pool-${pool.key}`}
                    className="num pool-input money"
                    value={pool.text}
                    inputMode="decimal"
                    invalid={pool.invalid}
                    label={t('newYear.tuitionAria', { label: pool.label })}
                    onInput={(v) => setNewPoolTuition(pool.key, v)}
                  />
                </div>
                {pool.invalid ? (
                  <p class="field-error" role="alert">
                    {t('settings.invalidAmount')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p class="muted small">{t('newYear.tuitionHint')}</p>
        </>
      ) : null}
      {plan.rateChanges.length > 0 ? (
        <>
          <span class="label">{t('newYear.rateChanges')}</span>
          <ul class="rate-changes money" id="new-year-rate-changes">
            {plan.rateChanges.map((c) => (
              <li key={c.poolKey} data-pool-key={c.poolKey}>
                {rateChangeText(c, true)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div class="row new-year-buttons">
        <span class="grow" />
        <Button variant="ghost" id="new-year-cancel" onClick={() => void cancelNewYear()}>
          {t('newYear.cancel')}
        </Button>
        <Button variant="primary" id="new-year-confirm" disabled={!plan.canConfirm} onClick={() => void confirmNewYear()}>
          {t('newYear.confirm')}
        </Button>
      </div>
    </div>
  );
}

export function YearsCard() {
  const years = yearViews.value;
  const result = newYearResult.value;
  const report = newYearReport.value;
  const onFiles = async (files: FileList) => {
    await startNewYear(await readImportItems(files));
  };
  const busy = newYearBusy.value;
  return (
    <section class="card settings-card settings-card--wide" id="card-years" aria-labelledby="years-title">
      <span class="label" id="years-title">
        {t('years.title')}
      </span>
      {years.length === 0 ? (
        <p class="muted small" id="years-none">
          {t('years.none')}
        </p>
      ) : (
        <ul class="year-list" id="year-list" aria-label={t('years.listAria')}>
          {years.map((y) => (
            <li key={y.year} data-year={y.year} data-role={y.role}>
              <div class="year-list__head">
                <b data-field="year-label">{y.label}</b>
                <span class={`tag tag--${y.role === 'archived' ? 'archived' : y.role}`} data-field="year-role">
                  {y.roleLabel}
                </span>
              </div>
              <span class="muted small" data-field="year-facts">
                {t('years.facts', { sessions: y.sessionCount, hours: y.hoursText })}
              </span>
              {y.tuitionText ? (
                <span class="muted small money" data-field="year-tuition">
                  {t('years.tuition', { amount: y.tuitionText })}
                </span>
              ) : null}
              {y.hasUnset ? <span class="muted small accent">{t('years.hasUnset')}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div class="row-between settings-row">
        <span class="muted small" role="status" aria-live="polite" id="new-year-status">
          {busy ? '…' : result?.kind === 'done' ? t('newYear.done') : result?.kind === 'cancelled' ? t('newYear.cancelled') : result?.kind === 'nothing' ? t('newYear.nothing') : result?.kind === 'imported' ? t('newYear.imported') : ''}
        </span>
        <FileButton id="year-import-input" label={t('years.import')} ariaLabel={t('years.importAria')} multiple onFiles={(files) => void onFiles(files)} />
      </div>
      {report && report.failures.length > 0 && !newYear.value ? (
        <ul class="report" id="new-year-failures">
          {report.failures.map((f) => (
            <li class="is-error" key={`${f.name}-${f.reason}`}>
              {t(FAILURE_KEYS[f.reason], { name: f.name, message: f.message ?? '' })}
            </li>
          ))}
        </ul>
      ) : null}
      <NewYearPanel />
      <p class="muted small">{t('years.note')}</p>
    </section>
  );
}
