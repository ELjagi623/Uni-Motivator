// The basic settings page: tuition (per pool), billing period, currency, academic-year start and split date, and the
// imported calendars. Edits go to a draft; "save" shows the unit-price preview first when any price would change.
// Money and pools come from state / core; the page only shows and collects input.

import { useEffect, useRef, useState } from 'preact/hooks';
import { getCurrency } from '../../core/money';
import { CURRENCIES } from '../../data/currencies';
import { t, type MessageKey } from '../../i18n';
import {
  addCalendars,
  importReport,
  readImportItems,
  removeCalendarFromSettings,
  replaceCalendar,
  replaceReport,
  settingsCalendars,
  type ImportFailureReason,
} from '../../state/calendars';
import { navigate } from '../../state/router';
import { SCHOOL_MAX_LENGTH, schoolName, setSchoolName } from '../../state/school';
import { activeNow, minuteBucket } from '../../state/now';
import { DEFAULT_REMINDERS } from '../../state/config';
import {
  permission,
  reminderConfig,
  requestNotifyPermission,
  setReminderConfig,
  setRemindersEnabled,
} from '../../state/reminders';
import { clearSyncReport, lastSyncText, subscribe, syncErrorText, syncNow, syncRateText, syncReport, syncing } from '../../state/subscriptions';
import {
  adoptSplitDate,
  cancelSave,
  confirmSave,
  editDraft,
  pendingChanges,
  rateChangeText,
  resetDraft,
  saveSettings,
  setPoolText,
  settingsView,
  hasErrors,
  type BillingPeriod,
  type RateChange,
} from '../../state/settings';
import type { SubscriptionInfo } from '../../api/client';
import { Button, ChoiceGroup, Checkbox, TextInput } from '../components/controls';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FileButton } from '../components/FileButton';
import { AppearanceCard, BackupCard, BillingModeCard, ExchangeCard, ResetCard, YearsCard } from './SettingsExtras';
import { SplitChecks } from '../components/SplitChecks';

const FAILURE_KEYS: Record<ImportFailureReason, MessageKey> = {
  unsupported: 'onboarding.step5.errUnsupported',
  'not-calendar': 'onboarding.step5.errNotCalendar',
  'no-ics': 'onboarding.step5.errNoIcs',
  upload: 'onboarding.step5.errUpload',
};

function periodOptions() {
  return [
    { value: 'semester' as const, label: t('onboarding.period.semester') },
    { value: 'year' as const, label: t('onboarding.period.year') },
  ];
}

// ------------------------------------------------------------------ cards

function TuitionCard() {
  const view = settingsView.value;
  const { draft } = view;
  const symbol = getCurrency(draft.currency).symbol;
  return (
    <section class="card settings-card" id="card-tuition" aria-labelledby="tuition-title">
      <span class="label" id="tuition-title">
        {t('settings.tuition')}
      </span>
      <div class="row-between settings-row">
        <span>{t('settings.period')}</span>
        <ChoiceGroup<BillingPeriod> name="settings-period" legend={t('settings.period')} variant="seg" value={draft.billingPeriod} options={periodOptions()} onChange={(v) => editDraft({ billingPeriod: v })} />
      </div>
      <div class="field-group">
        <span>{t('settings.currency')}</span>
        <ChoiceGroup
          name="settings-currency"
          legend={t('settings.currency')}
          variant="chip"
          value={draft.currency}
          options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))}
          onChange={(v) => editDraft({ currency: v })}
        />
      </div>
      {view.pools.length === 0 ? (
        <p class="muted small" id="no-pools">
          {t('settings.noPools')}
        </p>
      ) : (
        <ul class="pool-fields" id="pool-fields">
          {view.pools.map((pool) => (
            <li key={pool.key} data-pool-key={pool.key} data-unset={pool.unset ? 'true' : 'false'}>
              <div class={`field${pool.invalid ? ' field--invalid' : ''}`}>
                <label class="muted" for={`pool-tuition-${pool.key}`}>
                  {pool.label}
                </label>
                <span class="grow" />
                <span class="num muted money" aria-hidden="true">
                  {symbol}
                </span>
                <TextInput
                  id={`pool-tuition-${pool.key}`}
                  className="num pool-input money"
                  value={pool.text}
                  inputMode="decimal"
                  placeholder={t('settings.unset')}
                  disabled={pool.readOnly}
                  invalid={pool.invalid}
                  describedBy={`pool-note-${pool.key}`}
                  label={t('settings.poolAria', { label: pool.label })}
                  onInput={(v) => setPoolText(pool.key, v)}
                />
              </div>
              <p id={`pool-note-${pool.key}`} class={pool.invalid ? 'field-error' : 'muted small'} role={pool.invalid ? 'alert' : undefined}>
                {pool.invalid ? (
                  t('settings.invalidAmount')
                ) : pool.readOnly ? (
                  <>
                    <span class="tag tag--archived" data-field="archived-tag">
                      {t('years.role.archived')}
                    </span>{' '}
                    {t('years.poolReadOnly')}
                  </>
                ) : pool.unset ? (
                  <>
                    <span class="tag tag--cancel" data-field="unset-tag">
                      {t('settings.unset')}
                    </span>{' '}
                  </>
                ) : (
                  ''
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p class="muted small">{t('settings.periodNote')}</p>
    </section>
  );
}

function AcademicCard() {
  const view = settingsView.value;
  const { draft, errors } = view;
  return (
    <section class="card settings-card" id="card-academic" aria-labelledby="academic-title">
      <span class="label" id="academic-title">
        {t('settings.academic')}
      </span>
      <div class="field-group">
        <div class="field">
          <label class="muted" for="settings-school">
            {t('settings.school')}
          </label>
          <span class="grow" />
          <TextInput id="settings-school" className="school-input" value={schoolName.value} placeholder={t('onboarding.step2.schoolPlaceholder')} maxLength={SCHOOL_MAX_LENGTH} label={t('settings.school')} onInput={setSchoolName} />
        </div>
      </div>
      <div class="field-group">
        <div class={`field${errors.yearStart ? ' field--invalid' : ''}`}>
          <label class="muted" for="settings-year-start">
            {t('settings.yearStart')}
          </label>
          <span class="grow" />
          <TextInput id="settings-year-start" className="num date-input" value={draft.yearStart} placeholder="MM-DD" maxLength={5} inputMode="numeric" invalid={errors.yearStart} label={t('settings.yearStart')} onInput={(v) => editDraft({ yearStart: v })} />
        </div>
      </div>
      <div class="field-group">
        <div class={`field${errors.splitDate ? ' field--invalid' : ''}`}>
          <label class="muted" for="settings-split-date">
            {t('settings.splitDate')}
          </label>
          <span class="grow" />
          <TextInput id="settings-split-date" className="num date-input" value={draft.splitDate} placeholder="MM-DD" maxLength={5} inputMode="numeric" invalid={errors.splitDate} label={t('settings.splitDate')} onInput={(v) => editDraft({ splitDate: v })} />
        </div>
      </div>
      {errors.yearStart || errors.splitDate ? (
        <p class="field-error" role="alert">
          {t('settings.dateInvalid')}
        </p>
      ) : null}
      <SplitChecks checks={view.splitChecks} id="settings-split-checks" onAdopt={(suggest) => void adoptSplitDate(suggest)} />
    </section>
  );
}

function ReplaceMessages() {
  const replace = replaceReport.value;
  const add = importReport.value;
  return (
    <div role="status" aria-live="polite" id="calendar-messages">
      {replace ? (
        <ul class="report">
          {replace.status === 'replaced' ? (
            <li id="replace-result">{t('settings.replace.replaced', { before: replace.sessionsBefore, after: replace.sessionsAfter, kept: replace.marksKept })}</li>
          ) : null}
          {replace.status === 'replaced' && replace.marksOrphaned > 0 ? <li>{t('settings.replace.orphaned', { n: replace.marksOrphaned })}</li> : null}
          {replace.status === 'unchanged' ? <li id="replace-result">{t('settings.replace.unchanged')}</li> : null}
          {replace.status === 'failed' ? <li class="is-error" id="replace-result">{t('settings.replace.failed')}</li> : null}
          {replace.failures.map((f) => (
            <li class="is-error" key={`${f.name}-${f.reason}`}>
              {t(FAILURE_KEYS[f.reason], { name: f.name, message: f.message ?? '' })}
            </li>
          ))}
        </ul>
      ) : null}
      {add ? (
        <ul class="report">
          {add.added > 0 ? <li>{t('onboarding.step5.added', { n: add.added })}</li> : null}
          {add.duplicates.map((name) => (
            <li key={`dup-${name}`}>{t('onboarding.step5.duplicate', { name })}</li>
          ))}
          {add.failures.map((f) => (
            <li class="is-error" key={`fail-${f.name}`}>
              {t(FAILURE_KEYS[f.reason], { name: f.name, message: f.message ?? '' })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SubscriptionRow({ id, name, info }: { id: string; name: string; info: SubscriptionInfo }) {
  void minuteBucket.value; // "5 minutes ago" is refreshed once a minute
  const busy = syncing.value === id;
  return (
    <>
      <span class="muted small sync-when" data-field="last-sync">
        {t('sync.last', { when: lastSyncText(info, activeNow.peek()) })}
      </span>
      {info.lastError ? (
        <span class="field-error sync-error" data-field="last-sync-error">
          {t('sync.lastError', { reason: syncErrorText(info.lastError) })}
        </span>
      ) : null}
      <Button small variant="ghost" id={`sync-${id}`} disabled={syncing.value !== null} ariaLabel={t('settings.syncAria', { name })} onClick={() => void syncNow(id)}>
        {busy ? t('settings.syncing') : t('settings.syncNow')}
      </Button>
    </>
  );
}

/** The link input. The link is typed here, sent to the local server once and never shown again. */
function SubscribeForm() {
  const [url, setUrl] = useState('');
  const busy = syncing.value === 'new';
  const submit = async () => {
    clearSyncReport();
    const report = await subscribe(url);
    if (report.status === 'ok') setUrl('');
  };
  return (
    <div class="field-group subscribe-form" id="subscribe-form">
      <label class="label" for="subscribe-url">
        {t('settings.subscribe.label')}
      </label>
      <div class="row subscribe-row">
        <div class="field grow">
          <TextInput id="subscribe-url" value={url} onInput={setUrl} label={t('settings.subscribe.label')} placeholder={t('settings.subscribe.placeholder')} />
        </div>
        <Button variant="ghost" id="subscribe-add" disabled={url.trim() === '' || syncing.value !== null} onClick={() => void submit()}>
          {busy ? t('settings.subscribe.adding') : t('settings.subscribe.add')}
        </Button>
      </div>
      <span class="muted small">{t('settings.subscribe.note')}</span>
    </div>
  );
}

function SyncMessages() {
  const report = syncReport.value;
  return (
    <div role="status" aria-live="polite" id="sync-messages">
      {report ? (
        <ul class="report">
          {report.status === 'error' ? (
            <li class="is-error" id="sync-result" data-status="error" data-code={report.errorCode ?? ''}>
              {t('sync.failed', { reason: syncErrorText(report.errorCode ?? 'network') })}
            </li>
          ) : (
            <li id="sync-result" data-status="ok" data-changed={report.changed ? 'true' : 'false'}>
              {report.changed ? t('sync.ok') : t('sync.okSame')}
            </li>
          )}
          {report.rateChanges.map((c) => (
            <li key={c.poolKey} class="sync-rate money" data-pool-key={c.poolKey}>
              {syncRateText(c)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CalendarCard() {
  const list = settingsCalendars.value;
  const onReplace = async (oldId: string, files: FileList) => {
    importReport.value = null;
    await replaceCalendar(oldId, await readImportItems(files));
  };
  const onAdd = async (files: FileList) => {
    replaceReport.value = null;
    await addCalendars(await readImportItems(files));
  };
  return (
    <section class="card settings-card" id="card-calendars" aria-labelledby="calendars-title">
      <span class="label" id="calendars-title">
        {t('settings.calendars')}
      </span>
      <div class="row-between settings-row">
        <span id="calendar-count">{t('settings.calendarCount', { n: list.length })}</span>
        <FileButton id="calendar-add-input" label={t('settings.addCalendar')} multiple onFiles={(files) => void onAdd(files)} />
      </div>
      <ul class="calendar-list" id="settings-calendar-list">
        {list.map((c) => (
          <li key={c.id} data-calendar-id={c.id}>
            <span class="grow calendar-list__name">{c.name}</span>
            <span class="muted small">{c.failed ? t('settings.calendarUnreadable') : t('settings.calendarEvents', { n: c.eventCount })}</span>
            {c.subscription ? (
              <SubscriptionRow id={c.id} name={c.name} info={c.subscription} />
            ) : (
              <FileButton id={`calendar-reimport-${c.id}`} label={t('settings.reimport')} ariaLabel={t('settings.reimportAria', { name: c.name })} multiple onFiles={(files) => void onReplace(c.id, files)} />
            )}
            {list.length > 1 ? (
              <Button small variant="ghost" ariaLabel={t('settings.removeAria', { name: c.name })} onClick={() => void removeCalendarFromSettings(c.id)}>
                {t('settings.removeCalendar')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <ReplaceMessages />
      <SubscribeForm />
      <SyncMessages />
    </section>
  );
}

const LEAD_CHOICES = [0, 2, 5, 10, 15, 30] as const;

function RemindersCard() {
  const cfg = reminderConfig.value;
  const perm = permission.value;
  const options = LEAD_CHOICES.map((n) => ({ value: String(n), label: n === 0 ? t('settings.reminders.leadOff') : t('settings.reminders.leadN', { n }) }));
  const lead = String(cfg.leadMinutes ?? DEFAULT_REMINDERS.leadMinutes);
  const all = options.some((o) => o.value === lead) ? options : [...options, { value: lead, label: t('settings.reminders.leadN', { n: lead }) }];
  return (
    <section class="card settings-card" id="card-reminders" aria-labelledby="reminders-title">
      <span class="label" id="reminders-title">
        {t('settings.reminders')}
      </span>
      <label class="row settings-row reminders-enable">
        <Checkbox checked={cfg.enabled} label={t('settings.reminders.enable')} onChange={(on) => void setRemindersEnabled(on)} />
        <span class="grow">{t('settings.reminders.enable')}</span>
      </label>
      <div class="field-group">
        <span>{t('settings.reminders.lead')}</span>
        <ChoiceGroup name="reminder-lead" legend={t('settings.reminders.lead')} variant="chip" value={lead} options={all} onChange={(v) => setReminderConfig({ leadMinutes: Number(v) })} />
      </div>
      <p class="muted small" id="notify-permission" data-permission={perm}>
        {t(`settings.reminders.perm.${perm}`)}
      </p>
      {perm === 'default' ? (
        <div>
          <Button small variant="ghost" id="notify-allow" onClick={() => void requestNotifyPermission()}>
            {t('settings.reminders.allow')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ the confirmation dialog

function RateDialog({ changes }: { changes: RateChange[] }) {
  const single = changes.length === 1 ? changes[0] : null;
  return (
    <ConfirmDialog
      id="rate-dialog"
      caption={t('settings.confirm.title')}
      heading={single ? rateChangeText(single, false) : t('settings.confirm.multi', { n: changes.length })}
      headingClass={single ? 'money' : undefined}
      confirmLabel={t('settings.confirm.ok')}
      cancelLabel={t('settings.confirm.cancel')}
      onConfirm={() => void confirmSave()}
      onCancel={cancelSave}
    >
      {single ? null : (
        <ul class="rate-changes money" id="rate-changes">
          {changes.map((c) => (
            <li key={c.poolKey} data-pool-key={c.poolKey}>
              {rateChangeText(c, true)}
            </li>
          ))}
        </ul>
      )}
      <span class="muted small">{t('settings.confirm.note')}</span>
    </ConfirmDialog>
  );
}

// ------------------------------------------------------------------ page

export function Settings() {
  const view = settingsView.value;
  const pending = pendingChanges.value;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
    importReport.value = null;
    replaceReport.value = null;
    clearSyncReport();
  }, []);
  const invalid = hasErrors(view.errors);
  return (
    <div class="settings-page" id="settings">
      <div class="topbar page-topbar">
        <h1 class="topbar__title page-title" tabIndex={-1} ref={headingRef} id="page-title">
          {t('settings.title')}
        </h1>
        <span class="grow" />
        <Button variant="ghost" id="settings-back" onClick={() => navigate('/')}>
          {t('settings.back')}
        </Button>
      </div>
      <div class="settings-grid">
        <TuitionCard />
        <BillingModeCard />
        <AcademicCard />
        <YearsCard />
        <CalendarCard />
        <ExchangeCard />
        <AppearanceCard />
        <RemindersCard />
        <BackupCard />
        <ResetCard />
      </div>
      <div class="panel__footer settings-footer">
        <span class={`grow${view.dirty ? ' accent' : ' muted'}`} id="settings-state" role="status">
          {view.dirty ? t('settings.dirty') : t('settings.clean')}
        </span>
        <div class="panel__footer-buttons">
          <Button variant="ghost" id="settings-revert" disabled={!view.dirty} onClick={resetDraft}>
            {t('settings.revert')}
          </Button>
          <Button variant="primary" id="settings-save" disabled={!view.dirty || invalid} onClick={() => void saveSettings()}>
            {t('settings.save')}
          </Button>
        </div>
      </div>
      {pending ? <RateDialog changes={pending} /> : null}
    </div>
  );
}
