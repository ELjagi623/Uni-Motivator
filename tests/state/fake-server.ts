// An in-memory stand-in for the local server's HTTP API, installed as the global `fetch`. Records every call so
// tests can assert on order, headers and bodies.

import { vi } from 'vitest';

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  json: unknown;
}

type Doc = { schemaVersion: number; rev: number; [key: string]: unknown };

export interface FakeServer {
  calls: RecordedCall[];
  docs: Record<'config' | 'marks' | 'slacks', Doc>;
  calendars: Map<string, string>;
  /** Make the next PUT of `name` fail with 409 (and pretend another tab had changed the document). */
  conflictNext(name: 'config' | 'marks' | 'slacks', doc?: Record<string, unknown>): void;
  failNext(status: number): void;
  /** Called for every request right after it is recorded (before the response is produced). */
  onCall: ((call: RecordedCall) => void) | null;
  puts(name?: string): RecordedCall[];
  restore(): void;
}

function respond(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `cal-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function installFakeServer(initial: Partial<Record<'config' | 'marks' | 'slacks', Record<string, unknown>>> = {}, calendars: Array<{ id: string; text: string }> = []): FakeServer {
  const docs: FakeServer['docs'] = {
    config: { schemaVersion: 1, rev: 0, ...initial.config },
    marks: { schemaVersion: 1, rev: 0, ...initial.marks },
    slacks: { schemaVersion: 1, rev: 0, ...initial.slacks },
  };
  const cals = new Map(calendars.map((c) => [c.id, c.text]));
  const calls: RecordedCall[] = [];
  const conflicts = new Map<string, Record<string, unknown> | undefined>();
  let failStatus: number | null = null;
  const hooks: { onCall: ((call: RecordedCall) => void) | null } = { onCall: null };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let json: unknown;
    if (body !== undefined && (headers['content-type'] ?? '').includes('json')) json = JSON.parse(body);
    const call = { method, url, headers, body, json };
    calls.push(call);
    hooks.onCall?.(call);

    if (failStatus !== null && method !== 'GET') {
      const status = failStatus;
      failStatus = null;
      return respond(status, { error: 'boom', message: 'server said no' });
    }
    if (method === 'GET' && url === '/api/data') {
      return respond(200, { ...docs, calendars: [...cals].map(([id, text]) => ({ id, text })) });
    }
    const put = /^\/api\/docs\/(config|marks|slacks)$/.exec(url);
    if (method === 'PUT' && put) {
      const name = put[1] as 'config' | 'marks' | 'slacks';
      const { rev, doc } = json as { rev: number; doc: Record<string, unknown> };
      if (conflicts.has(name)) {
        const other = conflicts.get(name);
        conflicts.delete(name);
        docs[name] = { schemaVersion: 1, ...(other ?? {}), rev: docs[name].rev + 1 };
        return respond(409, { error: 'rev_conflict', rev: docs[name].rev, doc: docs[name] });
      }
      if (rev !== docs[name].rev) return respond(409, { error: 'rev_conflict', rev: docs[name].rev, doc: docs[name] });
      docs[name] = { schemaVersion: 1, ...doc, rev: rev + 1 };
      return respond(200, { rev: rev + 1 });
    }
    if (method === 'POST' && url === '/api/calendars') {
      const id = fakeId(body ?? '');
      cals.set(id, body ?? '');
      return respond(201, { id });
    }
    const del = /^\/api\/calendars\/([^/]+)$/.exec(url);
    if (method === 'DELETE' && del) {
      const id = decodeURIComponent(del[1]);
      if (!cals.delete(id)) return respond(404, { error: 'not_found', message: 'no such calendar' });
      return respond(200, { ok: true });
    }
    return respond(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    docs,
    calendars: cals,
    conflictNext: (name, doc) => conflicts.set(name, doc),
    failNext: (status) => {
      failStatus = status;
    },
    get onCall() {
      return hooks.onCall;
    },
    set onCall(fn) {
      hooks.onCall = fn;
    },
    puts: (name) => calls.filter((c) => c.method === 'PUT' && (name === undefined || c.url === `/api/docs/${name}`)),
    restore: () => vi.unstubAllGlobals(),
  };
}
