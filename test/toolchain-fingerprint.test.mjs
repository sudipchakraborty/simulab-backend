import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, utimes, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { compileDependencyRoots, createToolchainFingerprint } from '../src/toolchain-fingerprint.mjs';
import { fileTreeFingerprint } from '../src/build-cache.mjs';

test('dependency selection expands actual recipe paths and excludes generated build output', () => {
  const base = resolve('test-dependency-fixture');
  const roots = compileDependencyRoots([
    'recipe.cpp.o.pattern={compiler.path}/g++ -I{compiler.sdk.path} -I{build.core.path}',
    'recipe.hooks.prebuild.1.pattern={runtime.platform.path}/tool {build.path}/build_opt.h',
    `compiler.path=${join(base, 'compiler', 'bin')}`,
    'compiler.sdk.path={runtime.tools.sdk.path}/sdk',
    `runtime.tools.sdk.path=${join(base, 'sdk')}`,
    `runtime.platform.path=${join(base, 'platform')}`,
    'build.core.path={runtime.platform.path}/cores/fake',
    `build.path=${join(base, 'generated')}`,
    `build.source.path=${join(base, 'source')}`,
    `runtime.tools.ctags.path=${join(base, 'ctags')}`,
    `runtime.tools.unused-gdb.path=${join(base, 'unused-debugger')}`,
  ]);
  assert(roots.includes(join(base, 'compiler')));
  assert(roots.includes(join(base, 'sdk')));
  assert(roots.includes(join(base, 'platform')));
  assert(roots.includes(join(base, 'ctags')));
  assert(!roots.some((path) => path.includes('generated') || path.includes('unused-debugger')));
});

test('watched compiler fingerprints stay warm and invalidate preserved-time external header edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simulab-watched-inputs-'));
  const platform = join(root, 'data', 'packages', 'vendor', 'hardware', 'test', '1.0');
  const user = join(root, 'user');
  const executable = join(root, 'cli.exe'), configFile = join(root, 'cli.json');
  let resolutions = 0;
  const cli = async (args) => {
    if (args[0] === 'config') return { code: 0, stdout: JSON.stringify({ config: { directories: { data: join(root, 'data'), user } } }) };
    resolutions++;
    return { code: 0, stdout: JSON.stringify({ builder_result: { build_properties: [
      `runtime.platform.path=${platform}`,
      'build.core.path={runtime.platform.path}/cores/test',
      'recipe.cpp.o.pattern={build.core.path}/compiler',
    ] } }) };
  };
  const fingerprint = createToolchainFingerprint({ cli, executable, configFile });
  try {
    await mkdir(join(platform, 'cores', 'test'), { recursive: true });
    await mkdir(user, { recursive: true });
    await writeFile(executable, 'trusted fake executable');
    await writeFile(configFile, '{}');
    await writeFile(join(platform, 'platform.txt'), 'version=1');
    const header = join(platform, 'cores', 'test', 'external.h');
    await writeFile(header, 'value-a');
    const first = await fingerprint('uno', join(root, 'sketch'));
    assert.equal(await fingerprint('uno', join(root, 'sketch')), first);
    assert.equal(resolutions, 1);
    const before = await stat(header);
    await writeFile(header, 'value-b');
    await utimes(header, before.atime, before.mtime);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const changed = await fingerprint('uno', join(root, 'sketch'));
    assert.notEqual(changed, first);
    assert.equal(await fingerprint('uno', join(root, 'sketch')), changed);
    await mkdir(join(user, 'libraries'), { recursive: true });
    await writeFile(join(user, 'libraries', 'new.h'), 'new input');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.notEqual(await fingerprint('uno', join(root, 'sketch')), changed);
    await writeFile(join(platform, 'platform.txt'), 'version=2');
    await fingerprint('uno', join(root, 'sketch'));
    assert.equal(resolutions, 2);
  } finally { fingerprint.close(); await rm(root, { recursive: true, force: true }); }
});

test('access-only watcher notifications stay warm, unrelated parent files are ignored and real edits fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simulab-access-events-'));
  const data = join(root, 'data'), platform = join(data, 'platform'), user = join(root, 'user');
  const executable = join(root, 'cli.exe'), configFile = join(root, 'cli.json'), header = join(platform, 'external.h');
  const callbacks = new Map();
  let scans = 0, mutateContinuously = false;
  const cli = async (args) => ({ code: 0, stdout: JSON.stringify(args[0] === 'config'
    ? { config: { directories: { data, user } } }
    : { builder_result: { build_properties: [`runtime.platform.path=${platform}`, 'recipe.cpp.o.pattern={runtime.platform.path}/compiler'] } }) });
  const fingerprint = createToolchainFingerprint({ cli, executable, configFile,
    watch(path, _options, callback) {
      callbacks.set(path, callback);
      return { close() { callbacks.delete(path); }, unref() {}, on() {} };
    },
    async scan(paths, options) {
      const digest = await fileTreeFingerprint(paths, options);
      if (options?.onEntry) {
        scans++;
        if (mutateContinuously) await writeFile(header, `concurrent-edit-${scans}`);
        callbacks.get(platform)?.('change', 'external.h'); // Windows LAST_ACCESS can follow a read with unchanged bytes/mtime.
      }
      return digest;
    },
  });
  try {
    await mkdir(platform, { recursive: true }); await mkdir(user, { recursive: true });
    await writeFile(executable, 'fake'); await writeFile(configFile, '{}'); await writeFile(header, 'value-a');
    const first = await fingerprint('uno', join(root, 'sketch'));
    assert.equal(scans, 1);
    assert.equal(await fingerprint('uno', join(root, 'sketch')), first);
    assert.equal(scans, 1);
    await writeFile(join(data, 'inventory.yaml'), 'unrelated CLI inventory');
    callbacks.get(data)?.('change', 'inventory.yaml');
    assert.equal(await fingerprint('uno', join(root, 'sketch')), first);
    assert.equal(scans, 1);
    const before = await stat(header);
    await writeFile(header, 'value-b'); await utimes(header, before.atime, before.mtime);
    callbacks.get(platform)?.('change', 'external.h');
    const changed = await fingerprint('uno', join(root, 'sketch'));
    assert.notEqual(changed, first); assert.equal(scans, 2);
    await mkdir(join(data, 'libraries')); await writeFile(join(data, 'libraries', 'builtin.h'), 'new input');
    callbacks.get(data)?.('rename', 'libraries');
    const withBuiltin = await fingerprint('uno', join(root, 'sketch'));
    assert.notEqual(withBuiltin, changed);
    assert.equal(scans, 3);
    callbacks.get(platform)?.('change', undefined);
    assert.equal(await fingerprint('uno', join(root, 'sketch')), withBuiltin);
    assert.equal(scans, 4); // An unknown event requires a fresh complete snapshot.
    mutateContinuously = true;
    await writeFile(header, 'kick off genuine mutation'); callbacks.get(platform)?.('change', 'external.h');
    await assert.rejects(fingerprint('uno', join(root, 'sketch')), /inputs changed/);
    const failedScans = scans;
    mutateContinuously = false;
    assert.notEqual(await fingerprint('uno', join(root, 'sketch')), withBuiltin);
    assert.equal(scans, failedScans + 1); // Recovery revalidates; an earlier accepted digest cannot leak through failure.
    let unobservedScans = 0;
    const unobserved = createToolchainFingerprint({ cli, executable, configFile,
      watch() { throw new Error('Watcher unavailable'); },
      async scan(paths, options) {
        if (options?.onEntry) unobservedScans++;
        return fileTreeFingerprint(paths, options);
      },
    });
    try {
      const full = await unobserved('uno', join(root, 'sketch'));
      assert.equal(unobservedScans, 2);
      assert.equal(await unobserved('uno', join(root, 'sketch')), full);
      assert.equal(unobservedScans, 4); // Failed watchers use repeated full snapshots, never the warm cache shortcut.
    } finally { unobserved.close(); }
  } finally { fingerprint.close(); await rm(root, { recursive: true, force: true }); }
});
