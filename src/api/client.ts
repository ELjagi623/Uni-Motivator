// Thin wrapper around the local server's HTTP API. No state, no business logic.

export type DocName = 'config' | 'marks' | 'slacks';

/** A stored document as the server returns it. */
export interface RawDoc {
  schemaVersion: number;
  rev: number;
  [key: string]: unknown;
}

export interface CalendarFile {
  id: string;
  text: string;
}

export interface DataBundle {
  config: RawDoc;
  marks: RawDoc;
  slacks: RawDoc;
  calendars: CalendarFile[];
}

export type PutResult = { ok: true; rev: number } | { ok: false; conflict: true; current: RawDoc };

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const WRITE_HEADERS = { 'X-Tuition-Ticker': '1' } as const;

async function failure(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (typeof body.message === 'string') message = body.message;
  } catch {
    /* body was not JSON */
  }
  return new ApiError(res.status, message);
}

export async function getData(): Promise<DataBundle> {
  const res = await fetch('/api/data');
  if (!res.ok) throw await failure(res);
  return (await res.json()) as DataBundle;
}

/** Replace a whole document. A stale `rev` is reported as `{ok: false, conflict: true}` instead of an error. */
export async function putDoc(name: DocName, rev: number, doc: Record<string, unknown>): Promise<PutResult> {
  const res = await fetch(`/api/docs/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...WRITE_HEADERS },
    body: JSON.stringify({ rev, doc }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { doc: RawDoc };
    return { ok: false, conflict: true, current: body.doc };
  }
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { rev: number };
  return { ok: true, rev: body.rev };
}

/** Upload one .ics text; returns the calendar id chosen by the server. */
export async function postCalendar(text: string): Promise<string> {
  const res = await fetch('/api/calendars', {
    method: 'POST',
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...WRITE_HEADERS },
    body: text,
  });
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { id: string }).id;
}

export async function deleteCalendar(id: string): Promise<void> {
  const res = await fetch(`/api/calendars/${encodeURIComponent(id)}`, { method: 'DELETE', headers: WRITE_HEADERS });
  if (!res.ok && res.status !== 404) throw await failure(res);
}
