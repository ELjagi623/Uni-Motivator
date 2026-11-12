// Step 6 of the wizard (reused by the settings page later): which calendar events are really classes?

import { t, type MessageKey } from '../../i18n';
import type { CourseGroup, GroupReason } from '../../core/courses';
import { groupColor, groupHours, isGroupSelected, setGroupCredits, setGroupName, setGroupSelected, draft, groups, preview } from '../../state/onboarding';
import { Checkbox, TextInput } from '../components/controls';

const REASON_KEYS: Record<Exclude<GroupReason, 'ok'>, MessageKey> = {
  'too-few': 'onboarding.step6.reasonTooFew',
  'bad-duration': 'onboarding.step6.reasonBadDuration',
  'excluded-keyword': 'onboarding.step6.reasonKeyword',
};

function Row({ group, index }: { group: CourseGroup; index: number }) {
  const d = draft.value;
  const on = isGroupSelected(d, group);
  const name = d.names[group.key] ?? group.name;
  const label = group.code ?? group.name;
  return (
    <li class={`course-row${on ? ' is-on' : ''}`} data-group-key={group.key}>
      <Checkbox checked={on} label={t('onboarding.step6.selectAria', { name: label })} onChange={(checked) => setGroupSelected(group.key, checked)} />
      <div class="course-row__title">
        <TextInput id={`course-name-${index}`} value={name} onInput={(v) => setGroupName(group.key, v)} label={t('onboarding.step6.nameAria', { name: label })} />
        <span class="muted small">
          {group.code ? `${group.code} · ` : ''}
          {group.reason === 'ok' ? t('onboarding.step6.sessionsOnly', { count: group.count }) : t(REASON_KEYS[group.reason])}
        </span>
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
            id={`course-credits-${index}`}
            className="credits num"
            value={d.credits[group.key] ?? ''}
            placeholder="—"
            inputMode="decimal"
            maxLength={5}
            onInput={(v) => setGroupCredits(group.key, v)}
            label={t('onboarding.step6.creditsAria', { name: label })}
          />
        </span>
      </div>
      <span class="swatch" role="img" aria-label={t('onboarding.step6.colColor')} style={on ? { background: groupColor(index) } : undefined} />
    </li>
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
  return (
    <div class="step-body">
      <ul class="course-list" aria-label={t('onboarding.step6.listAria')}>
        <li class="course-head" aria-hidden="true">
          <span />
          <span>{t('onboarding.step6.colTitle')}</span>
          <span>{t('onboarding.step6.colCount')}</span>
          <span>{t('onboarding.step6.colHours')}</span>
          <span>{t('onboarding.step6.colCredits')}</span>
          <span />
        </li>
        {list.map((group, index) => (
          <Row key={group.key} group={group} index={index} />
        ))}
      </ul>
      {preview.value.sessionCount === 0 ? (
        <p class="field-error" role="alert">
          {t('onboarding.step6.needOne')}
        </p>
      ) : null}
    </div>
  );
}
