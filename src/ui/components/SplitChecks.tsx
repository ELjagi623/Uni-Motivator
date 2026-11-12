// The split-date check result (one line per academic year); shared by the wizard's preview step and the settings page.
// When the check suggests another split date, a button adopts it in one click.

import { t } from '../../i18n';
import type { SplitCheckView } from '../../state/onboarding';
import { Button } from './controls';

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

export interface SplitChecksProps {
  checks: readonly SplitCheckView[];
  id: string;
  /** Called with the suggested MM-DD when the user presses "adopt". */
  onAdopt?: (suggest: string) => void;
}

export function SplitChecks({ checks, id, onAdopt }: SplitChecksProps) {
  if (checks.length === 0) return null;
  return (
    <ul class="split-checks" id={id}>
      {checks.map((c) => (
        <li key={c.year} data-status={c.status}>
          {splitMessage(c)}
          {c.status === 'suggest' && c.suggestedSplit && onAdopt ? (
            <>
              {' '}
              <Button small variant="primary" id={`${id}-adopt-${c.year}`} ariaLabel={t('split.adoptAria', { year: c.year, suggest: c.suggestedSplit })} onClick={() => onAdopt(c.suggestedSplit as string)}>
                {t('split.adopt', { suggest: c.suggestedSplit })}
              </Button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
