export const DICTIONARIES: Array<{ locale: string; file: string }>;
export const COPY_FILES: Array<{ locale: string; file: string }>;
export function parseDictionary(text: string): Array<{ key: string; value: string }>;
export function parseCopyLibrary(text: string): Record<string, Record<string, string[]>>;
export function checkI18n(dictTexts: Record<string, string>, copyTexts: Record<string, string>): string[];
