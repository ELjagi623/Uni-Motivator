// "Add a class by hand": a weekly arrangement (a course the calendar does not have) or a one-off make-up / extra class,
// plus the list of what was added. The page only collects input; src/state/manual.ts validates, previews the price change
// and writes.

import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_WEEKLY_SESSIONS } from '../../core/manual';
import { t, type MessageKey } from '../../i18n';
import {
  addSingle,
  addWeekly,
  cancelManual,
  confirmManual,
  emptySingleForm,
  emptyWeeklyForm,
  manualAddedTick,
  manualItems,
  manualPending,
  removeSingle,
  removeWeekly,
  type ManualFail,
  type ManualOutcome,
  type SingleForm,
  type WeeklyForm,
} from '../../state/manual';
import { courses } from '../../state/derived';
import { rateChangeText } from '../../state/settings';
import { Button, ChoiceGroup, Select, TextInput } from '../components/controls';
import { ConfirmDialog } from '../components/ConfirmDialog';

type Tab = 'weekly' | 'single';
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

function ProblemList({ problems }: { problems: readonly ManualFail[] }) {
  if (problems.length === 0) return null;
  return (
    <ul class="report manual-errors" role="alert" id="manual-errors">
      {problems.map((p) => (
        <li class="is-error" key={p} data-problem={p}>
          {t(`manual.err.${p}` as MessageKey, { max: MAX_WEEKLY_SESSIONS })}
        </li>
      ))}
    </ul>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <div class="field-group manual-field">
      <label class="muted" for={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <span class="muted small">{hint}</span> : null}
    </div>
  );
}

function CourseSelect({ value, onChange, withNew }: { value: string; onChange: (v: string) => void; withNew: boolean }) {
  const list = courses.value;
  const options = [...(withNew ? [{ value: '', label: t('manual.courseNew') }] : []), ...list.map((c) => ({ value: c.id, label: c.code && !c.name.includes(c.code) ? `${c.code} ${c.name}` : c.name }))];
  return <Select id="manual-course" value={value} options={options} label={t('manual.course')} onChange={onChange} />;
}

/** Calls `onAdded` each time a class has really been added (the form is kept while the price question is open or was cancelled). */
function useOnAdded(onAdded: () => void): void {
  const tick = manualAddedTick.value;
  const seen = useRef(tick);
  useEffect(() => {
    if (seen.current === tick) return;
    seen.current = tick;
    onAdded();
  });
}

function WeeklyFormView({ onResult }: { onResult: (o: ManualOutcome) => void }) {
  const [f, setF] = useState<WeeklyForm>(emptyWeeklyForm());
  useOnAdded(() => setF(emptyWeeklyForm()));
  const set = (patch: Partial<WeeklyForm>) => setF((cur) => ({ ...cur, ...patch }));
  const isNew = f.courseId === '';
  const submit = () => {
    const outcome = addWeekly(f);
    onResult(outcome);
  };
  return (
    <div class="manual-form" id="manual-weekly-form">
      <Field label={t('manual.course')} htmlFor="manual-course">
        <CourseSelect value={f.courseId} onChange={(v) => set({ courseId: v })} withNew />
      </Field>
      {isNew ? (
        <>
          <Field label={t('manual.name')} htmlFor="manual-name">
            <TextInput id="manual-name" value={f.name} onInput={(v) => set({ name: v })} label={t('manual.name')} />
          </Field>
          <div class="manual-row">
            <Field label={t('manual.code')} htmlFor="manual-code">
              <TextInput id="manual-code" value={f.code} onInput={(v) => set({ code: v })} label={t('manual.code')} />
            </Field>
            <Field label={t('manual.credits')} htmlFor="manual-credits">
              <TextInput id="manual-credits" value={f.credits} inputMode="decimal" maxLength={5} onInput={(v) => set({ credits: v })} label={t('manual.credits')} />
            </Field>
          </div>
        </>
      ) : null}
      <div class="field-group">
        <span class="muted">{t('manual.weekday')}</span>
        <ChoiceGroup
          name="manual-weekday"
          legend={t('manual.weekday')}
          variant="chip"
          value={String(f.weekday)}
          options={WEEKDAY_ORDER.map((d) => ({ value: String(d), label: t(`manual.weekday.${d}` as MessageKey) }))}
          onChange={(v) => set({ weekday: Number(v) })}
        />
      </div>
      <div class="manual-row">
        <Field label={t('manual.start')} htmlFor="manual-start">
          <TextInput id="manual-start" className="num" value={f.start} placeholder="HH:MM" maxLength={5} onInput={(v) => set({ start: v })} label={t('manual.start')} />
        </Field>
        <Field label={t('manual.end')} htmlFor="manual-end">
          <TextInput id="manual-end" className="num" value={f.end} placeholder="HH:MM" maxLength={5} onInput={(v) => set({ end: v })} label={t('manual.end')} />
        </Field>
      </div>
      <div class="manual-row">
        <Field label={t('manual.from')} htmlFor="manual-from">
          <TextInput id="manual-from" className="num" value={f.fromDate} placeholder="YYYY-MM-DD" maxLength={10} onInput={(v) => set({ fromDate: v })} label={t('manual.from')} />
        </Field>
        <Field label={t('manual.to')} htmlFor="manual-to">
          <TextInput id="manual-to" className="num" value={f.toDate} placeholder="YYYY-MM-DD" maxLength={10} onInput={(v) => set({ toDate: v })} label={t('manual.to')} />
        </Field>
      </div>
      <Field label={t('manual.skip')} htmlFor="manual-skip" hint={t('manual.skipHint')}>
        <TextInput id="manual-skip" className="num" value={f.skipText} onInput={(v) => set({ skipText: v })} label={t('manual.skip')} />
      </Field>
      <Field label={t('manual.zone')} htmlFor="manual-zone" hint={t('manual.zoneHint')}>
        <TextInput id="manual-zone" value={f.timeZone} onInput={(v) => set({ timeZone: v })} label={t('manual.zone')} />
      </Field>
      <div>
        <Button variant="primary" id="manual-submit-weekly" onClick={submit}>
          {t('manual.submit')}
        </Button>
      </div>
    </div>
  );
}

function SingleFormView({ onResult }: { onResult: (o: ManualOutcome) => void }) {
  const first = courses.value[0]?.id ?? '';
  const [f, setF] = useState<SingleForm>({ ...emptySingleForm(), courseId: first });
  useOnAdded(() => setF((cur) => ({ ...emptySingleForm(), courseId: cur.courseId })));
  const set = (patch: Partial<SingleForm>) => setF((cur) => ({ ...cur, ...patch }));
  const submit = () => {
    const outcome = addSingle(f);
    onResult(outcome);
  };
  return (
    <div class="manual-form" id="manual-single-form">
      <Field label={t('manual.course')} htmlFor="manual-course">
        <CourseSelect value={f.courseId} onChange={(v) => set({ courseId: v })} withNew={false} />
      </Field>
      <Field label={t('manual.date')} htmlFor="manual-date">
        <TextInput id="manual-date" className="num" value={f.date} placeholder="YYYY-MM-DD" maxLength={10} onInput={(v) => set({ date: v })} label={t('manual.date')} />
      </Field>
      <div class="manual-row">
        <Field label={t('manual.start')} htmlFor="manual-start">
          <TextInput id="manual-start" className="num" value={f.start} placeholder="HH:MM" maxLength={5} onInput={(v) => set({ start: v })} label={t('manual.start')} />
        </Field>
        <Field label={t('manual.end')} htmlFor="manual-end">
          <TextInput id="manual-end" className="num" value={f.end} placeholder="HH:MM" maxLength={5} onInput={(v) => set({ end: v })} label={t('manual.end')} />
        </Field>
      </div>
      <Field label={t('manual.zone')} htmlFor="manual-zone" hint={t('manual.zoneHint')}>
        <TextInput id="manual-zone" value={f.timeZone} onInput={(v) => set({ timeZone: v })} label={t('manual.zone')} />
      </Field>
      <div>
        <Button variant="primary" id="manual-submit-single" onClick={submit}>
          {t('manual.submit')}
        </Button>
      </div>
    </div>
  );
}

function ConfirmView() {
  const pending = manualPending.value;
  if (!pending) return null;
  const changes = pending.changes;
  const single = changes.length === 1 ? changes[0] : null;
  return (
    <ConfirmDialog
      id="manual-dialog"
      caption={t('manual.confirm.title')}
      heading={single ? t('manual.confirm.single', { text: rateChangeText(single, true) }) : t('manual.confirm.multi', { n: changes.length })}
      headingClass="money"
      confirmLabel={t('manual.confirm.ok')}
      cancelLabel={t('manual.confirm.cancel')}
      onConfirm={() => void confirmManual()}
      onCancel={cancelManual}
    >
      {single ? null : (
        <ul class="rate-changes money" id="manual-rate-changes">
          {changes.map((c) => (
            <li key={c.poolKey} data-pool-key={c.poolKey}>
              {rateChangeText(c, true)}
            </li>
          ))}
        </ul>
      )}
      <span class="muted small">{t('manual.confirm.note')}</span>
    </ConfirmDialog>
  );
}

export function ManualPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('weekly');
  const [problems, setProblems] = useState<ManualFail[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const items = manualItems.value;
  const onResult = (o: ManualOutcome) => {
    if (o.status === 'invalid') {
      setProblems(o.problems);
      setMessage(null);
      return;
    }
    setProblems([]);
    setMessage(o.status === 'added' ? t('manual.added') : o.status === 'removed' ? t('manual.removed') : null);
  };
  return (
    <section class="card manual-panel" id="manual-panel" aria-labelledby="manual-title">
      <div class="detail__head">
        <span class="label" id="manual-title">
          {t('manual.title')}
        </span>
        <Button small variant="ghost" id="manual-close" onClick={onClose}>
          {t('manual.close')}
        </Button>
      </div>
      <p class="muted small">{t('manual.note')}</p>
      <ChoiceGroup<Tab>
        name="manual-tab"
        legend={t('manual.tabsAria')}
        variant="seg"
        value={tab}
        options={[
          { value: 'weekly', label: t('manual.tab.weekly') },
          { value: 'single', label: t('manual.tab.single') },
        ]}
        onChange={(v) => {
          setTab(v);
          setProblems([]);
          setMessage(null);
        }}
      />
      {tab === 'weekly' ? <WeeklyFormView onResult={onResult} /> : <SingleFormView onResult={onResult} />}
      <ProblemList problems={problems} />
      {message ? (
        <p class="muted small" role="status" id="manual-status">
          {message}
        </p>
      ) : null}
      <span class="label">{t('manual.listTitle')}</span>
      {items.length === 0 ? (
        <p class="muted small" id="manual-list-none">
          {t('manual.listNone')}
        </p>
      ) : (
        <ul class="manual-list" id="manual-list">
          {items.map((it) => (
            <li key={it.id} data-manual-id={it.id} data-kind={it.kind}>
              <span class="grow">
                {it.kind === 'weekly'
                  ? t('manual.listWeekly', { title: it.title, weekday: t(`manual.weekday.${it.weekday}` as MessageKey), start: it.start, end: it.end, from: it.fromDate, to: it.toDate, n: it.sessionCount })
                  : t('manual.listSingle', { title: it.title, date: it.fromDate, start: it.start, end: it.end })}
              </span>
              <Button small variant="ghost" ariaLabel={t('manual.removeAria', { title: it.title })} disabled={it.readOnly} onClick={() => onResult(it.kind === 'weekly' ? removeWeekly(it.id) : removeSingle(it.id))}>
                {t('manual.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmView />
    </section>
  );
}
