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

/** A calendar that is fed by a subscription link. The link itself never leaves the server. */
export interface SubscriptionInfo {
  calendarId: string;
  addedMs: number | null;
  /** When the calendar was last downloaded successfully (real time, UTC ms). */
  lastSyncMs: number | null;
  /** Code of the last failed sync (see SYNC_ERROR_CODES), or null when the last sync worked. */
  lastError: string | null;
}

export interface DataBundle {
  config: RawDoc;
  marks: RawDoc;
  slacks: RawDoc;
  calendars: CalendarFile[];
  subscriptions?: SubscriptionInfo[];
}

export interface SyncResult {
  calendarId: string;
  lastSyncMs: number;
  /** False when the downloaded calendar was identical to the stored one. */
  changed: boolean;
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

/** A failed subscription request: `code` is one of the server's sync error codes (bad_url, timeout, network, ...). */
export class SyncApiError extends ApiError {
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message);
    this.name = 'SyncApiError';
    this.code = code;
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
export async function putDoc(name: DocName, rev: number, doc: Record<string, unknown>, options: { keepalive?: boolean } = {}): Promise<PutResult> {
  const res = await fetch(`/api/docs/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...WRITE_HEADERS },
    body: JSON.stringify({ rev, doc }),
    ...(options.keepalive ? { keepalive: true } : {}),
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

async function syncFailure(res: Response): Promise<SyncApiError> {
  let code = 'network';
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    /* not JSON */
  }
  return new SyncApiError(res.status, code, message);
}

/** Subscribe to an iCal link: the server downloads it first and stores nothing when that fails. */
export async function addSubscription(url: string): Promise<SyncResult> {
  const res = await fetch('/api/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...WRITE_HEADERS },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw await syncFailure(res);
  return (await res.json()) as SyncResult;
}

/** Download the subscribed calendar again now. */
export async function syncSubscription(calendarId: string): Promise<SyncResult> {
  const res = await fetch(`/api/calendars/${encodeURIComponent(calendarId)}/sync`, { method: 'POST', headers: WRITE_HEADERS });
  if (!res.ok) throw await syncFailure(res);
  return (await res.json()) as SyncResult;
}

export async function deleteCalendar(id: string): Promise<void> {
  const res = await fetch(`/api/calendars/${encodeURIComponent(id)}`, { method: 'DELETE', headers: WRITE_HEADERS });
  if (!res.ok && res.status !== 404) throw await failure(res);
}

// ------------------------------------------------------------------ backup

/** A refused backup import: `code` is the server's error code (bad_backup, unsupported_version, ...). */
export class ImportApiError extends ApiError {
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message);
    this.name = 'ImportApiError';
    this.code = code;
  }
}

/** The whole data as one JSON text, with the file name the server suggests. */
export async function fetchBackup(): Promise<{ text: string; fileName: string }> {
  const res = await fetch('/api/export');
  if (!res.ok) throw await failure(res);
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { text: await res.text(), fileName: match ? match[1] : 'tuition-ticker-backup.json' };
}

/** Send a backup file's text; the server validates it, saves the current data and replaces everything. */
export async function postImport(text: string): Promise<{ backup: string; calendars: number }> {
  const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', ...WRITE_HEADERS }, body: text });
  if (!res.ok) {
    let code = 'import_failed';
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* not JSON */
    }
    throw new ImportApiError(res.status, code, message);
  }
  return (await res.json()) as { backup: string; calendars: number };
}
