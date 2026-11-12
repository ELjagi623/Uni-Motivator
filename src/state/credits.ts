// Credits typed by the user (course recognition, settings). Only a number greater than zero is a credit value.

/** Largest credit value accepted (a typo guard, not a rule of any school). */
export const MAX_CREDITS = 1000;

/** '' -> null (not set: the course counts as 1 credit), a number in (0, 1000] -> that number, anything else -> undefined. */
export function parseCreditsText(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 && n <= MAX_CREDITS ? n : undefined;
}
