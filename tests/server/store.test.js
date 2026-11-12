import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore, atomicWriteFileSync, backupStamp, BACKUPS_KEPT, StoreError } from '../../server/store.js';
import { makeTempDir, removeDir } from './helpers.js';

const dirs = [];
function tempStore(options = {}) {
  const dataDir = makeTempDir('tt-store-');
  dirs.push(dataDir);
  return { dataDir, store: createStore({ dataDir, ...options }) };
}
afterEach(() => {
  while (dirs.length) removeDir(dirs.pop());
});

describe('store: empty documents', () => {
  it('returns an empty document with schemaVersion 1 and rev 0 when the file does not exist', () => {
    const { store } = tempStore();
    for (const name of ['config', 'marks', 'slacks']) {
      assert.deepEqual(store.readDoc(name), { schemaVersion: 1, rev: 0 });
    }
    assert.deepEqual(store.readAll().calendars, []);
  });

  it('rejects document names outside the whitelist', () => {
    const { store } = tempStore();
    assert.throws(() => store.readDoc('evil'), StoreError);
    assert.throws(() => store.writeDoc('../config', 0, {}), StoreError);
  });
});

describe('store: rev handling', () => {
  it('increments rev on every write and keeps schemaVersion', () => {
    const { store, dataDir } = tempStore();
    assert.deepEqual(store.writeDoc('config', 0, { a: 1 }), { ok: true, rev: 1 });
    assert.deepEqual(store.writeDoc('config', 1, { a: 2 }), { ok: true, rev: 2 });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(onDisk.rev, 2);
    assert.equal(onDisk.schemaVersion, 1);
    assert.equal(onDisk.a, 2);
  });

  it('reports a conflict with the current content when rev is stale, and does not write', () => {
    const { store } = tempStore();
    store.writeDoc('config', 0, { v: 'first' });
    const result = store.writeDoc('config', 0, { v: 'stale' });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(result.current.rev, 1);
    assert.equal(result.current.v, 'first');
    assert.equal(store.readDoc('config').v, 'first');
  });

  it('ignores any rev the client smuggles inside doc', () => {
    const { store } = tempStore();
    store.writeDoc('config', 0, { rev: 999, x: 1 });
    assert.equal(store.readDoc('config').rev, 1);
  });

  it('refuses to treat a corrupt file as empty (would overwrite user data)', () => {
    const { store, dataDir } = tempStore();
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"rev": 3, "oops');
    assert.throws(() => store.readDoc('config'), (e) => e instanceof StoreError && e.code === 'corrupt');
    assert.throws(() => store.writeDoc('config', 0, {}), (e) => e instanceof StoreError && e.code === 'corrupt');
  });
});

describe('store: atomic write', () => {
  it('leaves the original file intact and no .tmp file behind when writing fails midway', () => {
    const { store, dataDir } = tempStore();
    store.writeDoc('config', 0, { keep: 'me' });
    const target = path.join(dataDir, 'config.json');
    const before = fs.readFileSync(target, 'utf8');

    // Simulate a crash after a few bytes reached the temp file.
    const failingFs = {
      ...fs,
      writeSync(fd, data) {
        fs.writeSync(fd, String(data).slice(0, 5));
        throw new Error('disk full');
      },
    };
    assert.throws(() => atomicWriteFileSync(target, JSON.stringify({ rev: 2, big: 'x'.repeat(100) }), failingFs), /disk full/);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
    assert.deepEqual(
      fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')),
      [],
    );
  });

  it('leaves the original file intact when the final rename fails', () => {
    const { store, dataDir } = tempStore();
    store.writeDoc('config', 0, { keep: 'me' });
    const target = path.join(dataDir, 'config.json');
    const before = fs.readFileSync(target, 'utf8');
    const failingFs = {
      ...fs,
      renameSync() {
        const e = new Error('nope');
        e.code = 'EIO';
        throw e;
      },
    };
    assert.throws(() => atomicWriteFileSync(target, '{"rev":2}', failingFs), /nope/);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
    assert.equal(fs.existsSync(`${target}.tmp`), false);
  });

  it('writes complete JSON and leaves no .tmp file after a normal write', () => {
    const { store, dataDir } = tempStore();
    store.writeDoc('marks', 0, { a: [1, 2, 3] });
    assert.deepEqual(fs.readdirSync(dataDir).sort(), ['marks.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'marks.json'), 'utf8')).a, [1, 2, 3]);
  });
});

describe('store: backup rotation', () => {
  it('keeps at most 20 backups per document after 25 writes, with unique names (same-millisecond clock)', () => {
    // A frozen clock forces every backup into the same millisecond.
    const { store, dataDir } = tempStore({ now: () => 1_800_000_000_000 });
    for (const name of ['config', 'marks', 'slacks']) {
      for (let i = 0; i < 25; i++) {
        const r = store.writeDoc(name, i, { i });
        assert.equal(r.ok, true);
      }
    }
    for (const name of ['config', 'marks', 'slacks']) {
      const files = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.endsWith(`_${name}.json`));
      assert.equal(files.length, BACKUPS_KEPT, `${name}: expected ${BACKUPS_KEPT} backups, got ${files.length}`);
      assert.equal(new Set(files).size, files.length);
      for (const f of files) assert.match(f, /^\d{8}-\d{6}-\d{3}_/);
      // The newest backup is the state before the last write (i = 23); the oldest kept is i = 4.
      const sorted = files.slice().sort();
      const newest = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', sorted.at(-1)), 'utf8'));
      const oldest = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', sorted[0]), 'utf8'));
      assert.equal(newest.i, 23);
      assert.equal(oldest.i, 4);
    }
  });

  it('creates no backup on the very first write and one backup per later write', () => {
    const { store, dataDir } = tempStore();
    store.writeDoc('config', 0, { a: 1 });
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false);
    store.writeDoc('config', 1, { a: 2 });
    const files = store.backupFiles('config');
    assert.equal(files.length, 1);
    assert.match(files[0], /_config\.json$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', files[0]), 'utf8')).a, 1);
  });

  it('formats backup names as UTC YYYYMMDD-HHMMSS-mmm', () => {
    assert.equal(backupStamp(Date.UTC(2026, 10, 11, 21, 30, 5, 7)), '20261111-213005-007');
  });
});
