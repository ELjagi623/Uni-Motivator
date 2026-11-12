// The split-date check result (one line per academic year); shared by the wizard's preview step and the settings page.

import { t } from '../../i18n';
import type { SplitCheckView } from '../../state/onboarding';

export function splitMessage(check: SplitCheckView): string {
  const year = check.year;
  switch (check.status) {
    case 'ok':
      return t('onboarding.step7.splitOk', { year, split: check.split });
    case 'suggest':
      return t('onboarding.step7.splitSuggest', { year, from: check.gapFrom ?? '', to: check.gapTo ?? '', suggest: check.suggestedSplit ?? '' });
    case 'single-semester':
      return t('onboarding.step7.splitSingle', { year });
    default:
      return t('onboarding.step7.splitNoGap', { year });
  }
}

export function SplitChecks({ checks, id }: { checks: readonly SplitCheckView[]; id: string }) {
  if (checks.length === 0) return null;
  return (
    <ul class="split-checks" id={id}>
      {checks.map((c) => (
        <li key={c.year}>{splitMessage(c)}</li>
      ))}
    </ul>
  );
}
