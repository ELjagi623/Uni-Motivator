import { unzipSync } from 'fflate';

export interface IcsFile {
  /** File name inside the archive (or the original file name for a plain .ics). */
  name: string;
  text: string;
}

const decoder = new TextDecoder('utf-8');

function decode(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Extract every .ics file from a zip archive (macOS resource-fork entries are skipped). */
export function unzipIcs(data: Uint8Array): IcsFile[] {
  const entries = unzipSync(data);
  const out: IcsFile[] = [];
  for (const name of Object.keys(entries).sort()) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name)) continue;
    if (!name.toLowerCase().endsWith('.ics')) continue;
    out.push({ name, text: decode(entries[name]) });
  }
  return out;
}

/**
 * Turn an uploaded/dropped file into calendar texts: `.zip` is unzipped, anything else is decoded as UTF-8 text.
 */
export function readCalendarFile(name: string, data: Uint8Array): IcsFile[] {
  if (name.toLowerCase().endsWith('.zip')) return unzipIcs(data);
  return [{ name, text: decode(data) }];
}
