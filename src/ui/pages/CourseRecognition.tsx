// Step 6 of the wizard, and the same list when a new academic year's calendar is imported in the settings: which
// calendar events are really classes? Each row: tick, name, number of sessions, hours, credits and colour.

import { t, type MessageKey } from '../../i18n';
import type { CourseGroup, GroupReason } from '../../core/courses';
import { creditsInvalid, groupColor, groupHours, isGroupSelected, setGroupCredits, setGroupName, setGroupSelected, draft, groups, preview } from '../../state/onboarding';
import { Checkbox, TextInput } from '../components/controls';

const REASON_KEYS: Record<Exclude<GroupReason, 'ok'>, MessageKey> = {
  'too-few': 'onboarding.step6.reasonTooFew',
  'bad-duration': 'onboarding.step6.reasonBadDuration',
  'excluded-keyword': 'onboarding.step6.reasonKeyword',
};

export interface CourseListProps {
  groups: readonly CourseGroup[];
  isOn: (group: CourseGroup) => boolean;
  nameOf: (group: CourseGroup) => string;
  creditsOf: (group: CourseGroup) => string;
  onSelect: (key: string, on: boolean) => void;
  onName: (key: string, text: string) => void;
  onCredits: (key: string, text: string) => void;
  /** Distinguishes the ids of several lists on one page. */
  idPrefix?: string;
  /** Number of colours already used by earlier courses (so that new courses get fresh colours). */
  colorOffset?: number;
}

function Row({ group, index, p }: { group: CourseGroup; index: number; p: CourseListProps }) {
  const on = p.isOn(group);
  const name = p.nameOf(group);
  const credits = p.creditsOf(group);
  const bad = creditsInvalid(credits);
  const label = group.code ?? group.name;
  const prefix = p.idPrefix ?? 'course';
  return (
    <li class={`course-row${on ? ' is-on' : ''}`} data-group-key={group.key}>
      <Checkbox checked={on} label={t('onboarding.step6.selectAria', { name: label })} onChange={(checked) => p.onSelect(group.key, checked)} />
      <div class="course-row__title">
        <TextInput id={`${prefix}-name-${index}`} value={name} onInput={(v) => p.onName(group.key, v)} label={t('onboarding.step6.nameAria', { name: label })} />
        <span class="muted small">
          {group.code ? `${group.code} · ` : ''}
          {group.reason === 'ok' ? t('onboarding.step6.sessionsOnly', { count: group.count }) : t(REASON_KEYS[group.reason])}
        </span>
        {bad ? (
          <span class="field-error small" role="alert" id={`${prefix}-credits-error-${index}`}>
            {t('onboarding.step6.creditsInvalid')}
          </span>
        ) : null}
      </div>
      <div class="stats-line">
        <span class="num stat" data-label={t('onboarding.step6.colCount')}>
          {group.count}
        </span>
        <span class="num stat" data-label={t('onboarding.step6.colHours')}>
          {groupHours(group)} h
        </span>
        <span class="credits-wrap" data-label={t('onboarding.step6.colCredits')}>
          <TextInput
            id={`${prefix}-credits-${index}`}
            className="credits num"
            value={credits}
            placeholder="—"
            inputMode="decimal"
            maxLength={5}
            invalid={bad}
            describedBy={bad ? `${prefix}-credits-error-${index}` : undefined}
            onInput={(v) => p.onCredits(group.key, v)}
            label={t('onboarding.step6.creditsAria', { name: label })}
          />
        </span>
      </div>
      <span class="swatch" role="img" aria-label={t('onboarding.step6.colColor')} style={on ? { background: groupColor(index + (p.colorOffset ?? 0)) } : undefined} />
    </li>
  );
}

/** The list itself, bound to whatever state the caller passes in. */
export function CourseList(p: CourseListProps) {
  return (
    <ul class="course-list" aria-label={t('onboarding.step6.listAria')}>
      <li class="course-head" aria-hidden="true">
        <span />
        <span>{t('onboarding.step6.colTitle')}</span>
        <span>{t('onboarding.step6.colCount')}</span>
        <span>{t('onboarding.step6.colHours')}</span>
        <span>{t('onboarding.step6.colCredits')}</span>
        <span />
      </li>
      {p.groups.map((group, index) => (
        <Row key={group.key} group={group} index={index} p={p} />
      ))}
    </ul>
  );
}

export function CourseRecognition() {
  const list = groups.value;
  if (list.length === 0) {
    return (
      <p class="muted" role="status">
        {t('onboarding.step6.noEvents')}
      </p>
    );
  }
  const d = draft.value;
  return (
    <div class="step-body">
      <CourseList
        groups={list}
        isOn={(g) => isGroupSelected(d, g)}
        nameOf={(g) => d.names[g.key] ?? g.name}
        creditsOf={(g) => d.credits[g.key] ?? ''}
        onSelect={setGroupSelected}
        onName={setGroupName}
        onCredits={setGroupCredits}
      />
      {preview.value.sessionCount === 0 ? (
        <p class="field-error" role="alert">
          {t('onboarding.step6.needOne')}
        </p>
      ) : null}
    </div>
  );
}
