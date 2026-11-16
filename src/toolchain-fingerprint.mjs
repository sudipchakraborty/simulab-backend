import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { watch as filesystemWatch } from 'node:fs';
import { resolve, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { boards } from './boards.mjs';
import { fileTreeFingerprint, compilerInputSignature } from './build-cache.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const directories = async (path) => {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

/** @brief Expand Arduino's nested build-property references and retain the dependency names used by compile recipes. */
export function compileDependencyRoots(properties) {
  const values = new Map(properties.map((entry) => {
    const index = entry.indexOf('=');
    return [entry.slice(0, index), entry.slice(index + 1)];
  }));
  const used = new Set();
  const expand = (text, depth = 0) => {
    if (depth > 40) throw new Error('Compiler property expansion exceeded limit');
    let value = text;
    for (let iteration = 0; iteration < 40; iteration++) {
      const next = value.replace(/\{([^{}]+)\}/g, (placeholder, key) => {
        used.add(key);
        return values.has(key) ? expand(values.get(key), depth + 1) : placeholder;
      });
      if (next === value) return value;
      value = next;
    }
    throw new Error('Compiler property expansion did not terminate');
  };
  for (const [key, value] of values) if (key.startsWith('recipe.') && (key.endsWith('.pattern') || key.endsWith('.pattern.windows'))) expand(value);
  for (const key of ['compiler.path', 'compiler.sdk.path', 'runtime.platform.path', 'build.core.path', 'build.variant.path', 'runtime.tools.ctags.path']) { used.add(key); if (values.has(key)) expand(values.get(key)); }
  const generated = ['build.path', 'build.source.path'].filter((key) => values.has(key)).map((key) => resolve(expand(values.get(key))));
  const result = new Set();
  for (const key of used) {
    if (!key.endsWith('.path') || ['build.path', 'build.source.path'].includes(key)) continue;
    const value = values.has(key) ? expand(values.get(key)) : '';
    if (value && isAbsolute(value) && !generated.some((path) => resolve(value) === path || resolve(value).startsWith(path + sep))) result.add(resolve(value));
  }
  if (values.has('compiler.path')) result.add(dirname(resolve(expand(values.get('compiler.path')))));
  return [...result].sort();
}

/** @brief Resolve and fingerprint only actual compile-time SDK/compiler/core dependencies.
 * @param options Trusted CLI/configuration and bounded command adapter.
 * @details Configuration/platform manifests and installed tool-version directory names invalidate root selection.
 * The first lookup scans selected compiler/SDK/core trees and installed user/builtin libraries. Subsequent
 * lookups reuse that digest only while registered filesystem watchers observe no changes. Source/configuration
 * content is hashed even when timestamps are preserved. Watcher failures fall back to full validation.
 */
export function createToolchainFingerprint({ cli, executable, configFile, watch = filesystemWatch, scan = fileTreeFingerprint }) {
  const selections = new Map();
  const pathKey = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const close = (entry) => { for (const monitor of entry.monitors ?? []) monitor.close(); entry.monitors = []; };
  /** Validate notified inputs rather than treating Windows LAST_ACCESS events as writes. */
  const notificationsUnchanged = async (entry) => {
    if (!entry.reliable || entry.uncertain) return false;
    const budget = { bytes: 0, deadline: performance.now() + 60000 };
    for (let pass = 0; pass < 3; pass++) {
      const pending = [...entry.dirty]; entry.dirty.clear();
      for (let offset = 0; offset < pending.length; offset += 32) {
        const checked = await Promise.all(pending.slice(offset, offset + 32).map(async ([key, path]) =>
          (await compilerInputSignature(path, budget)) === entry.signatures.get(key)));
        if (checked.some((unchanged) => !unchanged)) return false;
      }
      if (!entry.reliable || entry.uncertain) return false;
      if (!entry.dirty.size) return true;
    }
    return false;
  };
  const monitor = async (entry) => {
    close(entry);
    entry.reliable = true; entry.uncertain = false; entry.dirty.clear();
    const roots = [...new Set(entry.inputs.map((path) => resolve(path)))].sort();
    const minimal = roots.filter((path) => !roots.some((parent) => parent !== path && path.startsWith(parent + sep)));
    for (const input of minimal) {
      const exists = (await stat(input).catch(() => undefined))?.isDirectory();
      const path = exists ? input : dirname(input);
      if (!(await stat(path).catch(() => undefined))?.isDirectory()) { entry.reliable = false; continue; }
      try {
        const handle = watch(path, { recursive: !!exists }, (_event, filename) => {
          if (!filename) { entry.uncertain = true; return; }
          const name = filename.toString();
          // A missing directory/file watches its parent, but unrelated siblings are not compiler inputs.
          if (!exists && name.split(/[\\/]/)[0].toLowerCase() !== basename(input).toLowerCase()) return;
          if (/(?:^|[\\/])__pycache__(?:[\\/]|$)|\.py[co]$/i.test(name)) return;
          const changed = resolve(path, name);
          if (!changed.startsWith(resolve(path) + sep) || entry.dirty.size >= 220000) { entry.uncertain = true; return; }
          entry.dirty.set(pathKey(changed), changed);
        });
        handle.unref();
        handle.on('error', () => { entry.uncertain = true; entry.reliable = false; });
        entry.monitors.push(handle);
      } catch { entry.reliable = false; }
    }
  };
  const fingerprint = async (board, sketch) => {
    if (!boards[board] || !sketch) throw new Error('Compiler profile/workspace is required for cache validation');
    const response = await cli(['config', 'dump', '--format', 'json'], { timeoutMs: 10000 });
    if (response.code !== 0) throw new Error('Cannot validate compiler configuration');
    let config;
    try { config = JSON.parse(response.stdout).config; } catch { throw new Error('Compiler configuration response is invalid'); }
    const dirs = config?.directories;
    if (!dirs?.data || !dirs?.user) throw new Error('Compiler directories are unavailable for cache validation');
    const packages = join(dirs.data, 'packages'), manifests = [], versions = [];
    for (const vendor of await directories(packages)) {
      for (const architecture of await directories(join(packages, vendor, 'hardware'))) {
        for (const version of await directories(join(packages, vendor, 'hardware', architecture))) {
          const path = join(packages, vendor, 'hardware', architecture, version);
          versions.push(path);
          for (const name of ['platform.txt', 'platform.local.txt', 'boards.txt', 'boards.local.txt', 'installed.json']) manifests.push(join(path, name));
        }
      }
      for (const tool of await directories(join(packages, vendor, 'tools')))
        for (const version of await directories(join(packages, vendor, 'tools', tool))) versions.push(join(packages, vendor, 'tools', tool, version));
    }
    const selection = hash(JSON.stringify({ config, versions, metadata: await scan([executable, configFile, ...manifests]) }));
    let selected = selections.get(board);
    if (selected?.selection !== selection) {
      const result = await cli(['compile', '--fqbn', boards[board].fqbn, '--show-properties=unexpanded', '--json', sketch], { timeoutMs: 30000 });
      if (result.code !== 0) throw new Error('Cannot resolve compiler dependencies for cache validation');
      let properties;
      try { properties = JSON.parse(result.stdout).builder_result?.build_properties; } catch { /* Validated below. */ }
      if (!Array.isArray(properties) || !properties.length) throw new Error('Compiler dependency response is invalid');
      const roots = compileDependencyRoots(properties);
      if (!roots.length) throw new Error('Compiler dependency roots are unavailable');
      if (selected) close(selected);
      selected = { selection, roots, inputs: [...roots, join(dirs.user, 'libraries'), dirs.builtin?.libraries ?? join(dirs.data, 'libraries')], monitors: [], dirty: new Map(), signatures: new Map(), uncertain: false, reliable: false };
      selections.set(board, selected);
    }
    if (selected.digest && await notificationsUnchanged(selected)) return selected.digest;
    selected.digest = undefined; // A failed revalidation must never expose the previously accepted digest.
    // Register watchers before scanning; a mutation during validation must never become a cache hit.
    await monitor(selected);
    let unobservedDigest;
    for (let attempt = 0; attempt < 2; attempt++) {
      const signatures = new Map();
      const digest = await scan([executable, configFile, ...selected.inputs], { onEntry(path, signature) { signatures.set(pathKey(path), signature); } });
      selected.signatures = signatures;
      // Without a working watcher, require two equal full snapshots and never take the warm fast path.
      if (!selected.reliable) {
        if (unobservedDigest === digest) { selected.digest = digest; return digest; }
        unobservedDigest = digest;
        continue;
      }
      if (await notificationsUnchanged(selected)) {
        selected.digest = digest;
        return digest;
      }
    }
    throw new Error('Compiler inputs changed during cache validation; retry when edits finish');
  };
  fingerprint.close = () => { for (const entry of selections.values()) close(entry); selections.clear(); };
  return fingerprint;
}
