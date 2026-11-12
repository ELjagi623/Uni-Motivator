// File-backed document store for data/. Plain Node built-ins only.
//
// Layout:
//   data/<name>.json                         config | marks | slacks
//   data/calendars/<id>.ics                  imported calendars (POST / DELETE /api/calendars)
//   data/backups/YYYYMMDD-HHMMSS-mmm_<name>.json   copy of the previous file taken before every overwrite
//
// Writes are synchronous on purpose: read-check-write of one document can never interleave with
// another request, so the `rev` check is race-free inside a single server process.

import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DOC_NAMES = Object.freeze(['config', 'marks', 'slacks']);
export const BACKUPS_KEPT = 20;
export const SCHEMA_VERSION = 1;
/** Marker of the backup file format (GET /api/export, POST /api/import). */
export const BACKUP_APP = 'tuition-ticker';
export const BACKUP_KIND = 'backup';
/** How many "before import" safety copies are kept in data/backups/. */
export const IMPORT_BACKUPS_KEPT = 10;
export const MAX_IMPORT_CALENDARS = 200;
/** The longest calendar text a backup may carry (the request itself is capped at MAX_IMPORT_BYTES = 20 MB). */
export const MAX_IMPORT_CALENDAR_CHARS = 20 * 1024 * 1024;

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** Calendar ids are `cal-` + 12 hex digits of the SHA-256 of the text; any other id must be safe as a file name. */
export const CALENDAR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isCalendarId(id) {
  return typeof id === 'string' && CALENDAR_ID_RE.test(id);
}

export function isDocName(name) {
  return typeof name === 'string' && DOC_NAMES.includes(name);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** UTC timestamp used in backup file names; sorts lexicographically in chronological order. */
export function backupStamp(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `-${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}` +
    `-${pad(d.getUTCMilliseconds(), 3)}`
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `data` to `filePath` atomically: write + fsync a sibling .tmp file, then rename over the target.
 * If anything fails, the .tmp file is removed and the original file is left untouched.
 */
export function atomicWriteFileSync(filePath, data, fs = nodeFs) {
  const tmp = `${filePath}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // On Windows an antivirus scanner or indexer can briefly hold the target; retry a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
        if (!transient || attempt >= 5) throw err;
        sleepSync(20 * (attempt + 1));
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ---------------------------------------------------------------- backup content checks
//
// A backup is checked field by field BEFORE anything is written: a wrongly typed value (a tuition of "abc", a theme of 42)
// would otherwise replace the working data and make the pages show NaN or crash. The enumerations below are the ones the
// front-end uses (src/data/currencies.ts, src/i18n, src/core/types.ts, src/state/config.ts, src/data/regions.ts); the
// server stays self-contained and does not import from src/. Unknown extra fields are tolerated and kept, so a file
// written by a later version that added a field is still accepted. Error messages name the field only, never its value.

const CURRENCY_CODES = Object.freeze(['HKD', 'CNY', 'USD', 'GBP', 'EUR', 'CAD', 'AUD']);
const LOCALE_CODES = Object.freeze(['zh-CN', 'zh-TW', 'en']);
const INTENSITIES = Object.freeze(['gentle', 'normal', 'extreme']);
const THEME_CHOICES = Object.freeze(['system', 'light', 'dark']);
const BILLING_MODES = Object.freeze(['duration', 'credit']);
const BILLING_PERIODS = Object.freeze(['semester', 'year']);
const REGION_IDS = Object.freeze(['northern', 'southern']);
const MARK_STATUSES = Object.freeze(['cancelled', 'skipped']);
const MAX_TEXT_CHARS = 10_000;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isString = (v) => typeof v === 'string' && v.length <= MAX_TEXT_CHARS;
const isText = (v) => isString(v) && v.length > 0;
const isMoney = (v) => Number.isSafeInteger(v) && v >= 0;
const isMonthDay = (v) => {
  const m = typeof v === 'string' ? /^(\d{1,2})-(\d{1,2})$/.exec(v.trim()) : null;
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const probe = new Date(Date.UTC(2000, month - 1, day)); // 2000 is a leap year: 02-29 is fine
  return month >= 1 && month <= 12 && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
};

const oneOf = (list) => (v) => list.includes(v);
const listOf = (list) => `must be one of ${list.join(', ')}`;
const nullable = (test) => (v) => v === null || test(v);
const stringList = (v) => Array.isArray(v) && v.every(isString);
const nonNegative = (v) => isFiniteNumber(v) && v >= 0;
const isBool = (v) => typeof v === 'boolean';
const MONEY_WHAT = 'must be a whole number of cents (0 or more), or null';

/**
 * Each rule is `[field, test, what, required?]`; an absent (undefined) field passes unless required. Returns the first
 * problem as "<path>.<field>: <what>" or null.
 */
function checkFields(obj, path, rules) {
  for (const [field, test, what, required] of rules) {
    const v = obj[field];
    if (v === undefined) {
      if (required) return `${path}.${field}: is missing`;
      continue;
    }
    if (!test(v)) return `${path}.${field}: ${what}`;
  }
  return null;
}

/** Every entry of an array is a plain object that passes `check(entry, path)`; the first problem is returned. */
function checkEach(list, path, maxEntries, check) {
  if (!Array.isArray(list)) return `${path}: must be a list`;
  if (list.length > maxEntries) return `${path}: has too many entries`;
  for (let i = 0; i < list.length; i++) {
    if (!isPlainObject(list[i])) return `${path}[${i}]: must be an object`;
    const problem = check(list[i], `${path}[${i}]`);
    if (problem) return problem;
  }
  return null;
}

/** `doc[field]` (when present) is an object whose own fields pass `rules`. */
function checkObject(doc, field, path, rules) {
  if (doc[field] === undefined) return null;
  if (!isPlainObject(doc[field])) return `${path}: must be an object`;
  return checkFields(doc[field], path, rules);
}

function checkConfig(config) {
  return (
    checkFields(config, 'config', [
      ['onboardingDone', isBool, 'must be true or false'],
      ['school', isString, 'must be text'],
      ['region', oneOf(REGION_IDS), listOf(REGION_IDS)],
      ['currency', oneOf(CURRENCY_CODES), listOf(CURRENCY_CODES)],
      ['secondaryCurrency', nullable(oneOf(CURRENCY_CODES)), listOf(CURRENCY_CODES)],
      ['billingMode', oneOf(BILLING_MODES), listOf(BILLING_MODES)],
      ['language', oneOf(LOCALE_CODES), listOf(LOCALE_CODES)],
      ['intensity', oneOf(INTENSITIES), listOf(INTENSITIES)],
      ['uiScale', (v) => isFiniteNumber(v) && v >= 50 && v <= 300, 'must be a number between 50 and 300'],
      ['theme', oneOf(THEME_CHOICES), listOf(THEME_CHOICES)],
    ]) ||
    checkObject(config, 'academic', 'config.academic', [
      ['yearStart', isMonthDay, 'must be a date written MM-DD', true],
      ['splitDate', isMonthDay, 'must be a date written MM-DD', true],
      ['billingPeriod', oneOf(BILLING_PERIODS), listOf(BILLING_PERIODS), true],
    ]) ||
    checkObject(config, 'tuition', 'config.tuition', [['defaultMinor', nullable(isMoney), MONEY_WHAT]]) ||
    checkTuitionPools(config.tuition) ||
    (config.courses !== undefined &&
      checkEach(config.courses, 'config.courses', 5000, (c, path) =>
        checkFields(c, path, [
          ['id', isText, 'must be non-empty text', true],
          ['name', isString, 'must be text', true],
          ['code', nullable(isString), 'must be text or null'],
          ['credits', nullable(nonNegative), 'must be a number (0 or more) or null'],
          ['color', isString, 'must be text'],
          ['manual', isBool, 'must be true or false'],
          ['match', (v) => isPlainObject(v) && stringList(v.codes) && stringList(v.titles), 'must be { codes: [text], titles: [text] }', true],
        ]),
      )) ||
    (config.calendars !== undefined &&
      checkEach(config.calendars, 'config.calendars', 1000, (c, path) =>
        checkFields(c, path, [
          ['id', isText, 'must be non-empty text', true],
          ['name', isString, 'must be text', true],
        ]),
      )) ||
    checkObject(config, 'reminders', 'config.reminders', [
      ['enabled', isBool, 'must be true or false'],
      ['leadMinutes', nonNegative, 'must be a number (0 or more)'],
    ]) ||
    checkRates(config.rates) ||
    null
  );
}

/** `config.tuition.byPool`: pool key -> cents or null. */
function checkTuitionPools(tuition) {
  const byPool = tuition && tuition.byPool;
  if (byPool === undefined) return null;
  if (!isPlainObject(byPool)) return 'config.tuition.byPool: must be an object';
  for (const [key, v] of Object.entries(byPool)) {
    if (!nullable(isMoney)(v)) return `config.tuition.byPool[${JSON.stringify(key.slice(0, 40))}]: ${MONEY_WHAT}`;
  }
  return null;
}

/** `config.rates`: the user's exchange-rate overrides, currency code -> number greater than 0. */
function checkRates(rates) {
  if (rates === undefined) return null;
  if (!isPlainObject(rates)) return 'config.rates: must be an object';
  for (const [code, v] of Object.entries(rates)) {
    if (!isFiniteNumber(v) || v <= 0) return `config.rates[${JSON.stringify(code.slice(0, 10))}]: must be a number greater than 0`;
  }
  return null;
}

function checkMarks(doc) {
  if (doc.marks !== undefined) {
    if (!isPlainObject(doc.marks)) return 'marks.marks: must be an object';
    for (const [id, mark] of Object.entries(doc.marks)) {
      const path = `marks.marks[${JSON.stringify(id.slice(0, 60))}]`;
      if (!isPlainObject(mark)) return `${path}: must be an object`;
      const problem = checkFields(mark, path, [
        ['status', oneOf(MARK_STATUSES), listOf(MARK_STATUSES)],
        ['lateMin', nonNegative, 'must be a number of minutes (0 or more)'],
        ['earlyMin', nonNegative, 'must be a number of minutes (0 or more)'],
      ]);
      if (problem) return problem;
    }
  }
  const manual = doc.manual;
  if (manual === undefined) return null;
  if (!isPlainObject(manual)) return 'marks.manual: must be an object';
  const zone = ['timeZone', isString, 'must be text'];
  return (
    (manual.weekly !== undefined &&
      checkEach(manual.weekly, 'marks.manual.weekly', 5000, (w, path) =>
        checkFields(w, path, [
          ['id', isText, 'must be non-empty text', true],
          ['courseId', isText, 'must be non-empty text', true],
          ['title', isString, 'must be text'],
          ['weekday', (v) => Number.isInteger(v) && v >= 0 && v <= 6, 'must be a whole number from 0 (Sunday) to 6'],
          ['start', isString, 'must be text'],
          ['end', isString, 'must be text'],
          ['fromDate', isString, 'must be text'],
          ['toDate', isString, 'must be text'],
          ['skipDates', stringList, 'must be a list of text'],
          zone,
        ]),
      )) ||
    (manual.singles !== undefined &&
      checkEach(manual.singles, 'marks.manual.singles', 20000, (x, path) =>
        checkFields(x, path, [
          ['id', isText, 'must be non-empty text', true],
          ['courseId', isText, 'must be non-empty text', true],
          ['title', isString, 'must be text'],
          ['date', isString, 'must be text'],
          ['start', isString, 'must be text'],
          ['end', isString, 'must be text'],
          zone,
        ]),
      )) ||
    null
  );
}

function checkSlacks(doc) {
  if (doc.records === undefined) return null;
  return checkEach(doc.records, 'slacks.records', 500000, (r, path) =>
    checkFields(r, path, [
      ['id', isText, 'must be non-empty text', true],
      ['sessionId', isText, 'must be non-empty text', true],
      ['startMs', isFiniteNumber, 'must be a number (milliseconds)', true],
      ['endMs', nullable(isFiniteNumber), 'must be a number (milliseconds)'],
    ]),
  );
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => number} [options.now]   injectable clock (ms), used for backup names only
 * @param {typeof nodeFs} [options.fs]   injectable fs (tests)
 * @param {number} [options.backupsKept]
 */
export function createStore({ dataDir, now = Date.now, fs = nodeFs, backupsKept = BACKUPS_KEPT }) {
  const root = path.resolve(dataDir);
  const backupsDir = path.join(root, 'backups');
  const calendarsDir = path.join(root, 'calendars');
  let lastBackupStamp = 0;

  const docPath = (name) => path.join(root, `${name}.json`);
  const emptyDoc = () => ({ schemaVersion: SCHEMA_VERSION, rev: 0 });

  function assertName(name) {
    if (!isDocName(name)) throw new StoreError('bad_name', `unknown document: ${String(name)}`);
  }

  function readDoc(name) {
    assertName(name);
    let text;
    try {
      text = fs.readFileSync(docPath(name), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptyDoc();
      throw err;
    }
    let doc;
    try {
      doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      throw new StoreError('corrupt', `${name}.json is not valid JSON; the previous copies are in data/backups/`);
    }
    if (!isPlainObject(doc)) throw new StoreError('corrupt', `${name}.json does not contain a JSON object`);
    if (!Number.isInteger(doc.rev) || doc.rev < 0) doc.rev = 0;
    if (!Number.isInteger(doc.schemaVersion)) doc.schemaVersion = SCHEMA_VERSION;
    return doc;
  }

  function backupFiles(name) {
    let entries;
    try {
      entries = fs.readdirSync(backupsDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const suffix = `_${name}.json`;
    return entries.filter((f) => f.endsWith(suffix) && /^\d{8}-\d{6}-\d{3}_/.test(f)).sort();
  }

  function backupExisting(name) {
    const src = docPath(name);
    if (!fs.existsSync(src)) return null;
    fs.mkdirSync(backupsDir, { recursive: true });
    // Names must be unique even when several writes land in the same millisecond (or the clock steps back).
    let stamp = Math.max(now(), lastBackupStamp + 1);
    let file = `${backupStamp(stamp)}_${name}.json`;
    while (fs.existsSync(path.join(backupsDir, file))) {
      stamp += 1;
      file = `${backupStamp(stamp)}_${name}.json`;
    }
    lastBackupStamp = stamp;
    fs.copyFileSync(src, path.join(backupsDir, file));
    // Rotation: keep only the newest `backupsKept` copies of this document.
    const all = backupFiles(name);
    for (const old of all.slice(0, Math.max(0, all.length - backupsKept))) {
      try {
        fs.rmSync(path.join(backupsDir, old), { force: true });
      } catch {
        /* a locked old backup must not fail the save */
      }
    }
    return file;
  }

  /**
   * Replace a whole document if `rev` matches the stored one.
   * @returns {{ok: true, rev: number} | {ok: false, conflict: true, current: object}}
   */
  function writeDoc(name, rev, doc) {
    assertName(name);
    if (!isPlainObject(doc)) throw new StoreError('bad_doc', 'doc must be a JSON object');
    if (!Number.isInteger(rev) || rev < 0) throw new StoreError('bad_rev', 'rev must be a non-negative integer');
    const current = readDoc(name);
    if (current.rev !== rev) return { ok: false, conflict: true, current };
    const next = {
      ...doc,
      schemaVersion: Number.isInteger(doc.schemaVersion) ? doc.schemaVersion : SCHEMA_VERSION,
      rev: current.rev + 1,
    };
    fs.mkdirSync(root, { recursive: true });
    backupExisting(name);
    atomicWriteFileSync(docPath(name), `${JSON.stringify(next, null, 2)}\n`, fs);
    return { ok: true, rev: next.rev };
  }

  /** Calendars stored as data/calendars/<id>.ics, returned as [{id, text}] (empty if none). */
  function readCalendars() {
    let entries;
    try {
      entries = fs.readdirSync(calendarsDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((f) => f.toLowerCase().endsWith('.ics'))
      .sort()
      .map((f) => ({ id: f.slice(0, -4), text: fs.readFileSync(path.join(calendarsDir, f), 'utf8') }));
  }

  /**
   * Store a calendar text as data/calendars/<id>.ics. The id derives from the content, so importing the same file
   * twice is a no-op (same id) instead of a duplicate.
   * @returns {{id: string, created: boolean}}
   */
  function addCalendar(text) {
    if (typeof text !== 'string') throw new StoreError('bad_calendar', 'calendar text must be a string');
    const id = `cal-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`;
    const file = path.join(calendarsDir, `${id}.ics`);
    const created = !fs.existsSync(file);
    if (created) {
      fs.mkdirSync(calendarsDir, { recursive: true });
      atomicWriteFileSync(file, text, fs);
    }
    return { id, created };
  }

  /** Store a calendar under a caller-chosen id (subscriptions keep one id for good), replacing the old text atomically. */
  function writeCalendar(id, text) {
    if (!isCalendarId(id)) throw new StoreError('bad_id', 'calendar id contains characters that are not allowed');
    if (typeof text !== 'string') throw new StoreError('bad_calendar', 'calendar text must be a string');
    fs.mkdirSync(calendarsDir, { recursive: true });
    atomicWriteFileSync(path.join(calendarsDir, `${id}.ics`), text, fs);
  }

  const subscriptionsFile = path.join(root, 'subscriptions.json');

  /**
   * Subscription links, kept in data/subscriptions.json: [{id, url, addedMs, lastSyncMs, lastError}] where `id` is the id of the
   * calendar the link feeds. The links are private: only calendar-sync.js reads them, the API never returns them.
   * An unreadable file is set aside (subscriptions.corrupt.json) instead of being overwritten.
   */
  function readSubscriptions() {
    let text;
    try {
      text = fs.readFileSync(subscriptionsFile, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    try {
      const doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (isPlainObject(doc) && Array.isArray(doc.subscriptions)) {
        return doc.subscriptions.filter((s) => isPlainObject(s) && isCalendarId(s.id) && typeof s.url === 'string');
      }
    } catch {
      /* fall through */
    }
    try {
      fs.renameSync(subscriptionsFile, path.join(root, 'subscriptions.corrupt.json'));
    } catch {
      /* best effort */
    }
    return [];
  }

  function writeSubscriptions(list) {
    fs.mkdirSync(root, { recursive: true });
    atomicWriteFileSync(subscriptionsFile, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, subscriptions: list }, null, 2)}
`, fs);
  }

  /** The public view of the subscriptions: which calendars are fed by a link, and how the last sync went (no link). */
  function publicSubscriptions() {
    return readSubscriptions().map((s) => ({
      calendarId: s.id,
      addedMs: Number.isFinite(s.addedMs) ? s.addedMs : null,
      lastSyncMs: Number.isFinite(s.lastSyncMs) ? s.lastSyncMs : null,
      lastError: typeof s.lastError === 'string' ? s.lastError : null,
    }));
  }

  /** @returns {boolean} whether a calendar was removed (a subscription feeding it is dropped as well) */
  function deleteCalendar(id) {
    if (!isCalendarId(id)) throw new StoreError('bad_id', 'calendar id contains characters that are not allowed');
    const subs = readSubscriptions();
    if (subs.some((s) => s.id === id)) writeSubscriptions(subs.filter((s) => s.id !== id));
    const file = path.join(calendarsDir, `${id}.ics`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  function readAll() {
    return {
      config: readDoc('config'),
      marks: readDoc('marks'),
      slacks: readDoc('slacks'),
      calendars: readCalendars(),
      subscriptions: publicSubscriptions(),
    };
  }

  // ---------------------------------------------------------------- backup: export / import

  const stripRev = (doc) => {
    const { rev: _rev, ...rest } = doc;
    return rest;
  };

  /**
   * The backup document: config, marks, slacks and the raw text of every calendar. Subscription links are private and are
   * NOT included (a subscribed calendar is exported as an ordinary calendar); `rev` numbers are bookkeeping and are left out.
   */
  function exportBackup() {
    return {
      app: BACKUP_APP,
      kind: BACKUP_KIND,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date(now()).toISOString(),
      config: stripRev(readDoc('config')),
      marks: stripRev(readDoc('marks')),
      slacks: stripRev(readDoc('slacks')),
      calendars: readCalendars(),
    };
  }

  /**
   * Check a backup document without touching anything.
   * @returns {{ok: true, backup: object} | {ok: false, code: string, message: string}}
   */
  function validateBackup(payload) {
    const bad = (code, message) => ({ ok: false, code, message });
    if (!isPlainObject(payload) || payload.app !== BACKUP_APP || payload.kind !== BACKUP_KIND) {
      return bad('bad_backup', 'this is not a backup file written by this program');
    }
    if (!Number.isInteger(payload.schemaVersion)) return bad('bad_backup', 'schemaVersion is missing');
    if (payload.schemaVersion !== SCHEMA_VERSION) {
      return bad('unsupported_version', `backup schemaVersion ${payload.schemaVersion} is not supported (expected ${SCHEMA_VERSION})`);
    }
    for (const name of DOC_NAMES) {
      const doc = payload[name];
      if (!isPlainObject(doc)) return bad('bad_backup', `${name} is missing or not an object`);
      if (!Number.isInteger(doc.schemaVersion)) return bad('bad_backup', `${name}.schemaVersion is missing`);
      if (doc.schemaVersion !== SCHEMA_VERSION) return bad('unsupported_version', `${name}.schemaVersion ${doc.schemaVersion} is not supported`);
    }
    if (!Array.isArray(payload.calendars) || payload.calendars.length > MAX_IMPORT_CALENDARS) return bad('bad_backup', 'calendars must be a list');
    const seen = new Set();
    for (const cal of payload.calendars) {
      if (!isPlainObject(cal) || !isCalendarId(cal.id) || typeof cal.text !== 'string') return bad('bad_backup', 'a calendar entry is malformed');
      if (cal.text.length > MAX_IMPORT_CALENDAR_CHARS) return bad('bad_backup', 'a calendar entry is too long');
      if (!/^\s*BEGIN:VCALENDAR/i.test(cal.text)) return bad('bad_backup', 'a calendar entry is not iCalendar text');
      if (seen.has(cal.id)) return bad('bad_backup', 'two calendars share an id');
      seen.add(cal.id);
    }
    // field-level checks (types and enumerations) of the three documents
    const problem = checkConfig(payload.config) || checkMarks(payload.marks) || checkSlacks(payload.slacks);
    if (problem) return bad('bad_backup', problem);
    return { ok: true, backup: payload };
  }

  /** Copy of everything that is about to be replaced (the export format plus the local-only subscription links). */
  function backupBeforeImport() {
    fs.mkdirSync(backupsDir, { recursive: true });
    let stamp = Math.max(now(), lastBackupStamp + 1);
    let file = `${backupStamp(stamp)}_before-import.json`;
    while (fs.existsSync(path.join(backupsDir, file))) {
      stamp += 1;
      file = `${backupStamp(stamp)}_before-import.json`;
    }
    lastBackupStamp = stamp;
    const snapshot = { ...exportBackup(), subscriptions: readSubscriptions() };
    atomicWriteFileSync(path.join(backupsDir, file), `${JSON.stringify(snapshot, null, 2)}\n`, fs);
    const all = fs.readdirSync(backupsDir).filter((f) => /^\d{8}-\d{6}-\d{3}_before-import\.json$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - IMPORT_BACKUPS_KEPT))) {
      try {
        fs.rmSync(path.join(backupsDir, old), { force: true });
      } catch {
        /* ignore */
      }
    }
    return file;
  }

  /**
   * Replace everything with a validated backup. The current data is saved first (data/backups/<stamp>_before-import.json).
   * Documents get rev + 1 so that pages that are still open notice the change; calendars not in the backup are deleted;
   * subscription records of calendars that are not in the backup are dropped, the others keep syncing.
   * @returns {{backup: string, calendars: number}}
   */
  function importBackup(backup) {
    const checked = validateBackup(backup);
    if (!checked.ok) throw new StoreError(checked.code, checked.message);
    const backupFile = backupBeforeImport();
    fs.mkdirSync(root, { recursive: true });
    for (const name of DOC_NAMES) {
      const current = readDoc(name);
      const next = { ...backup[name], schemaVersion: SCHEMA_VERSION, rev: current.rev + 1 };
      backupExisting(name);
      atomicWriteFileSync(docPath(name), `${JSON.stringify(next, null, 2)}\n`, fs);
    }
    const keep = new Set(backup.calendars.map((c) => c.id));
    for (const cal of backup.calendars) writeCalendar(cal.id, cal.text);
    for (const old of readCalendars()) if (!keep.has(old.id)) fs.rmSync(path.join(calendarsDir, `${old.id}.ics`), { force: true });
    const subs = readSubscriptions();
    const kept = subs.filter((s) => keep.has(s.id));
    if (kept.length !== subs.length) writeSubscriptions(kept);
    return { backup: backupFile, calendars: backup.calendars.length };
  }

  return { dataDir: root, exportBackup, validateBackup, importBackup, readDoc, writeDoc, readAll, readCalendars, addCalendar, writeCalendar, deleteCalendar, readSubscriptions, writeSubscriptions, backupFiles };
}
