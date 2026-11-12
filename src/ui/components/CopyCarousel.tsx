// A line of copy that changes every 8 seconds (never the same line twice in a row). Only this component re-renders.
// The tone (gentle / normal / extreme) comes from the settings and the language from the interface language; changing
// either picks a new line at once.

import { useEffect, useRef, useState } from 'preact/hooks';
import { pickCopy, type CopyVars } from '../../core/copy';
import type { CopyScene, Intensity } from '../../core/types';
import { getLocale } from '../../i18n';
import { copyIntensity } from '../../state/intensity';

export const CAROUSEL_INTERVAL_MS = 8000;

export interface CopyCarouselProps {
  scene: CopyScene;
  /** Overrides the tone from the settings (tests). */
  intensity?: Intensity;
  /** Values for the placeholders ({course}, {amount}, ...), evaluated each time a line is picked. */
  getVars: () => CopyVars;
  intervalMs?: number;
  /** Random source in [0, 1); injectable for tests. */
  random?: () => number;
  class?: string;
}

export function CopyCarousel({ scene, intensity, getVars, intervalMs = CAROUSEL_INTERVAL_MS, random, class: className }: CopyCarouselProps) {
  const level = intensity ?? copyIntensity.value;
  const locale = getLocale();
  const latest = useRef({ scene, level, locale, getVars, random });
  latest.current = { scene, level, locale, getVars, random };
  const pick = (previous: string | null): string | null => {
    const o = latest.current;
    return pickCopy({ intensity: o.level, locale: o.locale, scene: o.scene, vars: o.getVars(), previous, random: o.random });
  };
  const [text, setText] = useState<string | null>(() => pick(null));

  useEffect(() => {
    const id = setInterval(() => setText((previous) => pick(previous) ?? previous), intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  // A new tone or language: a line from the new set right away.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setText(pick(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, locale]);

  return (
    <p class={className} id="copy-line">
      {text}
    </p>
  );
}
