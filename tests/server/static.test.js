import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withServer, request, removeDir, makeTempDir } from './helpers.js';
import { startServer } from '../../server/index.js';
import { resolveRequestPath } from '../../server/static.js';

let s;
before(async () => {
  s = await withServer({ appFiles: { 'assets/app.js': 'console.log(1)', 'assets/app.css': 'body{}', 'fonts/a.woff2': 'wOF2' } });
});
after(async () => {
  await s.cleanup();
});

describe('static hosting', () => {
  it('serves index.html at / and falls back to it for unknown SPA paths', async () => {
    const root = await s.request({ path: '/' });
    assert.equal(root.status, 200);
    assert.match(root.text, /fixture-index/);
    assert.match(root.headers['content-type'], /text\/html/);
    for (const p of ['/some/spa/path', '/sessions', '/index.html?x=1']) {
      const r = await s.request({ path: p });
      assert.equal(r.status, 200, p);
      assert.match(r.text, /fixture-index/, p);
    }
  });

  it('serves existing files with the right content type', async () => {
    const js = await s.request({ path: '/assets/app.js' });
    assert.equal(js.status, 200);
    assert.equal(js.text, 'console.log(1)');
    assert.match(js.headers['content-type'], /javascript/);
    const css = await s.request({ path: '/assets/app.css' });
    assert.match(css.headers['content-type'], /text\/css/);
    const font = await s.request({ path: '/fonts/a.woff2' });
    assert.equal(font.headers['content-type'], 'font/woff2');
  });

  it('supports HEAD', async () => {
    const r = await s.request({ method: 'HEAD', path: '/' });
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
  });

  it('refuses path traversal in all encodings and never serves files outside app/', async () => {
    // A secret next to app/ that a successful traversal would reach.
    const secret = path.join(path.dirname(s.appDir), 'tt-secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET');
    try {
      const attempts = [
        '/..%2f..%2fpackage.json',
        '/%2e%2e/package.json',
        '/%2e%2e%2f%2e%2e%2fpackage.json',
        '/../package.json',
        '/assets/../../package.json',
        '/..%5c..%5cpackage.json',
        '/..\\..\\package.json',
        `/../${path.basename(secret)}`,
        `/%2e%2e/${path.basename(secret)}`,
        '/%00',
        '/C:/Windows/win.ini',
        '/assets/app.js::$DATA',
      ];
      for (const p of attempts) {
        const r = await s.request({ path: p });
        assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('TOP-SECRET'), p);
        assert.ok(!r.text.includes('"name": "tuition-ticker"'), p);
      }
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  it('answers malformed percent-encoding with 400', async () => {
    const r = await s.request({ path: '/%E0%A4%A' });
    assert.equal(r.status, 400);
  });

  it('rejects POST on static paths', async () => {
    const r = await s.request({ method: 'POST', path: '/', write: true });
    assert.equal(r.status, 405);
  });

  it('returns 503 with a hint when the front-end has not been built', async () => {
    const dataDir = makeTempDir('tt-data-');
    const emptyApp = makeTempDir('tt-emptyapp-');
    const inst = await startServer({ port: 0, dataDir, appDir: path.join(emptyApp, 'missing') });
    try {
      const r = await request(inst.port, { path: '/' });
      assert.equal(r.status, 503);
      assert.match(r.text, /npm run build/);
    } finally {
      await inst.close();
      removeDir(dataDir);
      removeDir(emptyApp);
    }
  });
});

describe('resolveRequestPath', () => {
  it('splits and normalises a safe path', () => {
    assert.deepEqual(resolveRequestPath('/a//b/./c?x=1#h'), { ok: true, segments: ['a', 'b', 'c'] });
    assert.deepEqual(resolveRequestPath('/'), { ok: true, segments: [] });
  });
  it('rejects dot-dot segments however they were encoded', () => {
    for (const u of ['/..', '/a/../b', '/%2e%2e/x', '/..%2fx', '/a%2f..%2fb']) {
      assert.equal(resolveRequestPath(u).ok, false, u);
    }
  });
});
