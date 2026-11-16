import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../src/service.mjs';

test('exact compile reuse keeps source timestamps, invalidates changed inputs and gives each session owned artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simulab-compile-cache-'));
  const origin = 'http://127.0.0.1:5173';
  const calls = [];
  let fingerprint = 'tools-and-libraries-v1';
  let fingerprintAvailable = true;
  const retainedCore = join(root, 'cache', 'uno', 'core', 'retained.o');
  await mkdir(join(root, 'cache', 'uno', 'core'), { recursive: true });
  await writeFile(retainedCore, 'legacy warm core');
  const runner = async (args) => {
    if (args[0] !== 'compile') return { code: 0, stdout: 'ok', stderr: '' };
    const source = args.at(-1);
    calls.push({ source, modified: (await stat(join(source, 'sketch.ino'))).mtimeMs, retainedCore: !!await stat(retainedCore).catch(() => undefined) });
    await writeFile(join(args[args.indexOf('--output-dir') + 1], 'sketch.ino.hex'), ':00000001FF\n');
    return { code: 0, stdout: 'compiled', stderr: '' };
  };
  const server = createCompanion({ token: 'private-test-token', origins: [origin], root, runner, buildFingerprint: async () => {
    if (!fingerprintAvailable) throw new Error('Dependency validation unavailable');
    return fingerprint;
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, session, body) => fetch(base + path, {
    method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const compile = (session, files, board = 'uno') => request('/compile', session, { board, files }).then((response) => response.json());
  try {
    const a = (await (await request('/simulation/session', null, {})).json()).session;
    const b = (await (await request('/simulation/session', null, {})).json()).session;
    const files = [{ name: 'sketch.ino', content: 'void setup(){} void loop(){}' }, { name: 'old.h', content: '// header' }];
    const first = await compile(a, files);
    const again = await compile(b, [...files].reverse());
    assert.equal(again.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].retainedCore, true); // First adoption lets the real CLI validate its warm incremental files.
    assert.notEqual(first.job, again.job);
    assert.equal((await request(`/artifact/${first.job}/sketch.ino.hex`, b)).status, 404);
    assert.equal((await request(`/artifact/${again.job}/sketch.ino.hex`, b)).status, 200);
    fingerprint = 'tools-and-libraries-v2';
    await compile(a, files);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].retainedCore, false); // Known tool/header changes must not reuse timestamp-only incremental objects.
    assert.equal(calls[0].source, calls[1].source);
    assert.equal(calls[0].modified, calls[1].modified);
    const changed = [{ name: 'sketch.ino', content: 'void setup(){} void loop(){delay(1);}' }];
    await compile(a, changed);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].source, calls[0].source);
    await assert.rejects(readFile(join(calls[2].source, 'old.h')), { code: 'ENOENT' });
    await compile(a, changed, 'nano');
    assert.equal(calls.length, 4);
    assert.notEqual(calls[2].source, calls[3].source);
    const external = [{ name: 'sketch.ino', content: '#/**/include "C:/shared/config.h"\nvoid setup(){} void loop(){}' }];
    assert.equal((await compile(a, external)).cached, false);
    assert.equal((await compile(a, external)).cached, false);
    assert.equal(calls.length, 6); // Explicit Build revalidates external dependencies through the real compiler.
    fingerprintAvailable = false;
    assert.equal((await request('/compile', a, { board: 'uno', files: changed })).status, 500);
    assert.equal(calls.length, 6); // A failed validator cannot turn an older artifact into a cache hit.
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('compiler progress is actual, owner-bound, validated and expires with authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simulab-compile-progress-'));
  const origin = 'http://127.0.0.1:5173';
  let clock = 1000;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const runner = async (args, options) => {
    options?.onProgress?.({ percent: 24, stage: 'Compiling' });
    entered();
    await pending;
    options?.onProgress?.({ percent: 12 }); // A later lower callback cannot move the UI backward.
    options?.onProgress?.({ percent: 80 });
    await mkdir(args[args.indexOf('--output-dir') + 1], { recursive: true });
    await writeFile(join(args[args.indexOf('--output-dir') + 1], 'sketch.ino.hex'), ':00000001FF\n');
    return { code: 0, stdout: 'compiled', stderr: '' };
  };
  const server = createCompanion({ token: 'private-test-token', origins: [origin], root, runner, now: () => clock, buildFingerprint: async () => 'v1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, session, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    const a = await (await request('/simulation/session', null, {})).json();
    const b = await (await request('/simulation/session', null, {})).json();
    const requestId = 'a'.repeat(32);
    const compile = request('/compile', a.session, { board: 'uno', requestId, files: [{ name: 'sketch.ino', content: 'void setup(){} void loop(){}' }] });
    await ready;
    const active = await request(`/compile-progress/${requestId}`, a.session);
    assert.equal(active.status, 200);
    assert.equal((await active.json()).percent, 24);
    assert.equal((await request(`/compile-progress/${requestId}`, b.session)).status, 404);
    assert.equal((await request('/compile-progress/not-an-id', a.session)).status, 400);
    clock += 500;
    finish();
    const result = await (await compile).json();
    assert.equal(result.success, true);
    const completed = await (await request(`/compile-progress/${requestId}`, a.session)).json();
    assert.equal(completed.percent, 100);
    assert.equal(completed.elapsedMs, 500);
    clock = a.expiresAt;
    assert.equal((await request(`/compile-progress/${requestId}`, a.session)).status, 401);
    assert.equal((await request('/compile', 'private-test-token', { board: 'uno', requestId: '../bad', files: [{ name: 'sketch.ino', content: '' }] })).status, 400);
  } finally {
    finish();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
