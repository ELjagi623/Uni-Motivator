// File-backed document store for data/. Plain Node built-ins only.
//
// Layout:
//   data/<name>.json                         config | marks | slacks
//   data/calendars/<id>.ics                  imported calendars (read-only here; written in a later phase)
//   data/backups/YYYYMMDD-HHMMSS-mmm_<name>.json   copy of the previous file taken before every overwrite
//
// Writes are synchronous on purpose: read-check-write of one document can never interleave with
// another request, so the `rev` check is race-free inside a single server process.

import nodeFs from 'node:fs';
import path from 'node:path';

export const DOC_NAMES = Object.freeze(['config', 'marks', 'slacks']);
export const BACKUPS_KEPT = 20;
export const SCHEMA_VERSION = 1;

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
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

  function readAll() {
    return {
      config: readDoc('config'),
      marks: readDoc('marks'),
      slacks: readDoc('slacks'),
      calendars: readCalendars(),
    };
  }

  return { dataDir: root, readDoc, writeDoc, readAll, readCalendars, backupFiles };
}
