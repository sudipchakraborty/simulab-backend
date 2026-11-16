import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBuildCache, fileTreeFingerprint, prepareWorkspace, ownedPath, canReuseExactArtifacts } from '../src/build-cache.mjs';
import { createCompileProgress } from '../src/compile-progress.mjs';

test('external or macro includes and build-time inputs conservatively bypass exact artifact reuse', () => {
  const eligible = (content, environment = {}) => canReuseExactArtifacts([{ name: 'sketch.ino', content }], environment);
  assert.equal(eligible('void setup(){} void loop(){}'), true);
  for (const content of ['#include "C:/shared/config.h"', '# include "../config.h"', '#include HEADER', '#include <Arduino.h>', '#inc\\\nlude HEADER', '#include_next <header.h>', '/*comment*/ #include "C:/shared/config.h"', '#/**/include "C:/shared/config.h"', '%:include "C:/shared/config.h"', '??=include "C:/shared/config.h"', '__has_include("C:/shared/config.h")', 'const char *t=__TIME__;', 'asm(".incbin data.bin");', '__asm__(".in" "cbin data.bin");']) assert.equal(eligible(content), false, content);
  assert.equal(eligible('void setup(){}', { CPATH: 'C:/shared' }), false);
});

test('cache fingerprint observes external source/configuration edits and file addition/removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simulab-fingerprint-'));
  try {
    const path = join(root, 'library.h');
    await writeFile(path, 'value a');
    const initial = await fileTreeFingerprint([root]);
    const before = await stat(path);
    await writeFile(path, 'value b');
    await utimes(path, before.atime, before.mtime);
    assert.notEqual(await fileTreeFingerprint([root]), initial);
    const changed = await fileTreeFingerprint([root]);
    await writeFile(join(root, 'new.h'), 'new');
    assert.notEqual(await fileTreeFingerprint([root]), changed);
    await assert.rejects(fileTreeFingerprint([root], { maxFiles: 1 }), /limit/);
    await assert.rejects(fileTreeFingerprint([root], { maxSourceBytes: 1 }), /byte limit/);
    await rm(join(root, 'new.h'));
    assert.equal(await fileTreeFingerprint([root]), changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact cache verifies corruption, bounds retained entries and checks workspace paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simulab-artifact-cache-'));
  try {
    const output = join(root, 'output');
    await mkdir(output);
    await writeFile(join(output, 'sketch.ino.hex'), ':00000001FF');
    const cache = createBuildCache(join(root, 'cache'), { maxEntries: 1 });
    const files = [{ name: 'sketch.ino', content: 'x' }];
    const a = cache.key('uno', 'arduino:avr:uno', files, 'v1');
    const b = cache.key('uno', 'arduino:avr:uno', files, 'v2');
    await cache.store(a, output, { success: true, artifacts: ['sketch.ino.hex'] });
    await cache.store(b, output, { success: true, artifacts: ['sketch.ino.hex'] });
    assert.equal(await cache.restore(a, join(root, 'restored-a')), undefined);
    await writeFile(join(root, 'cache', b, 'sketch.ino.hex'), 'corrupt');
    assert.equal(await cache.restore(b, join(root, 'restored-b')), undefined);
    await assert.rejects(readFile(join(root, 'restored-b', 'sketch.ino.hex')), { code: 'ENOENT' });
    assert.throws(() => ownedPath(root, '..', 'outside'), /escaped/);
    await assert.rejects(prepareWorkspace(root, '../outside', files), /profile/);
    await assert.rejects(prepareWorkspace(root, 'uno', [{ name: '../../outside.ino', content: 'x' }]), /escaped/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('progress records remain bounded and ETA is based only on measured noncached history', () => {
  let clock = 0;
  const store = createCompileProgress({ now: () => clock, limit: 2 });
  const a = store.start('a'.repeat(32), 'owner', 'esp32s3');
  assert.equal(store.get('a'.repeat(32), 'owner').percent, null);
  assert.equal(store.get('a'.repeat(32), 'owner').estimatedRemainingMs, undefined);
  clock = 1000;
  store.finish(a, true);
  const b = store.start('b'.repeat(32), 'owner', 'esp32s3');
  clock = 1200;
  assert.equal(store.get('b'.repeat(32), 'owner').estimatedRemainingMs, 800);
  store.update(b, { percent: 80 });
  store.update(b, { percent: 20 });
  assert.equal(store.get('b'.repeat(32), 'owner').percent, 80);
  const c = store.start('c'.repeat(32), 'owner', 'esp32s3');
  assert.throws(() => store.get('a'.repeat(32), 'owner'), /unavailable/);
  assert.throws(() => store.start('d'.repeat(32), 'owner', 'esp32s3'), /limit/);
  store.finish(b, false);
  store.finish(c, true, true);
  clock = 3601201;
  assert.throws(() => store.get('b'.repeat(32), 'owner'), /unavailable/);
});
