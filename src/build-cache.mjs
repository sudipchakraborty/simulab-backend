import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sourceInput = (path) => /\.(?:h|hpp|c|cpp|cxx|ino|txt|json|ya?ml|properties|csv|py|ld|s)$/i.test(path);
const directorySignature = (info) => JSON.stringify(['directory', String(info.mtimeNs)]);
const fileSignature = (info, digest) => JSON.stringify(['file', String(info.size), String(info.mtimeNs), digest]);

/** @brief Compare a notified compiler input using the same metadata/content policy as a full scan.
 * @param budget Shared limits for a bounded batch of filesystem notifications.
 * @details Access-time changes are excluded. Preserved-time source edits still change the content hash.
 */
export async function compilerInputSignature(path, budget) {
  if (performance.now() > budget.deadline) throw new Error('Compiler cache notification validation timed out');
  let info;
  try { info = await stat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (info.isDirectory()) return directorySignature(info);
  if (!info.isFile()) return 'other';
  let digest = '';
  if (sourceInput(path) && info.size <= 2_000_000n) {
    budget.bytes += Number(info.size);
    if (budget.bytes > 512 * 1024 * 1024) throw new Error('Compiler cache notification content exceeded limit');
    digest = hash(await readFile(path));
  }
  return fileSignature(info, digest);
}
/** @brief Admit exact reuse only when user source cannot add an untracked external include dependency.
 * @details All explicit includes (including macro and relative includes), embedded files, include probes,
 * and build-time macros conservatively use the real incremental compiler. Automatic Arduino core includes
 * remain covered by the selected SDK/core fingerprint. This deliberately favors freshness over cache coverage.
 */
export function canReuseExactArtifacts(files, environment = process.env) {
  if (['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH', 'LIBRARY_PATH', 'GCC_EXEC_PREFIX', 'COMPILER_PATH'].some((key) => environment[key])) return false;
  // Reject every preprocessing introducer, including digraphs/trigraphs and comments between tokens.
  // False negatives for cache admission are harmless: the real incremental compiler remains available.
  return files.every(({ content }) => !/#|%:|\?\?=|__has_(?:include|embed)\b|__(?:DATE|TIME|TIMESTAMP)__|\b(?:asm|__asm__?)\b|\.(?:incbin|include)\b/m.test(content.replace(/\\\r?\n/g, '')));
}
/** @brief Resolve a service-owned child and reject escapes before filesystem mutation. */
export function ownedPath(root, ...parts) {
  const base = resolve(root);
  const path = resolve(base, ...parts);
  if (!path.startsWith(base + sep)) throw new Error('Compiler path escaped its private workspace');
  return path;
}

/** @brief Fingerprint trusted compiler/core/library trees before every exact-artifact lookup.
 * @param paths Trusted executable/configuration and installed platform/library roots.
 * @details All file names, sizes and nanosecond modification times are included. Small source/configuration
 * files are additionally content-hashed, detecting normal external edits and preserved-time source replacements.
 * Generated Python caches are excluded because they are not compiler inputs. No source data is returned.
 */
export async function fileTreeFingerprint(paths, { maxFiles = 200000, maxDirectories = 20000, timeoutMs = 60000, maxSourceBytes = 512 * 1024 * 1024, onEntry } = {}) {
  const entries = [], files = [];
  const seen = new Set();
  const deadline = performance.now() + timeoutMs;
  let contentBytes = 0;
  const bounded = () => {
    if (files.length > maxFiles || seen.size > maxDirectories) throw new Error('Toolchain exceeds cache validation file/directory limit');
    if (performance.now() > deadline) throw new Error('Compiler cache validation timed out');
  };
  const walk = async (path) => {
    bounded();
    let info;
    try { info = await stat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isDirectory()) {
      const canonical = await realpath(path);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      bounded();
      onEntry?.(resolve(path), directorySignature(info));
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        bounded();
        if (child.name === '__pycache__' || child.name === '.git' || /\.py[co]$/i.test(child.name)) continue;
        if (child.isFile()) files.push(join(path, child.name));
        else await walk(join(path, child.name));
      }
    } else if (info.isFile()) {
      files.push(path);
    }
  };
  for (const path of paths.filter(Boolean)) await walk(resolve(path));
  bounded();
  files.sort();
  for (let i = 0; i < files.length; i += 32) {
    bounded();
    entries.push(...await Promise.all(files.slice(i, i + 32).map(async (path) => {
      let info;
      try { info = await stat(path, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return [resolve(path), 'missing']; throw error; }
      const source = sourceInput(path);
      if (source && info.size <= 2_000_000n) {
        contentBytes += Number(info.size);
        if (contentBytes > maxSourceBytes) throw new Error('Toolchain source content exceeds cache validation byte limit');
      }
      const digest = source && info.size <= 2_000_000n ? hash(await readFile(path)) : '';
      onEntry?.(resolve(path), fileSignature(info, digest));
      return [resolve(path), String(info.size), String(info.mtimeNs), digest];
    })));
  }
  bounded();
  return hash(JSON.stringify(entries));
}

/** @brief Stable per-board source workspace; unchanged files retain timestamps for Arduino incremental builds. */
export async function prepareWorkspace(root, board, files) {
  if (!/^[a-z0-9-]+$/.test(board)) throw new Error('Invalid compiler workspace profile');
  const path = ownedPath(root, 'workspaces', board, 'sketch');
  await mkdir(path, { recursive: true });
  const wanted = new Set(files.map((file) => file.name));
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile() && /^[A-Za-z][A-Za-z0-9_-]{0,63}\.(?:ino|h|hpp|cpp|c)$/.test(entry.name) && !wanted.has(entry.name))
      await rm(ownedPath(path, entry.name));
  }
  for (const file of files) {
    const target = ownedPath(path, file.name);
    let previous;
    try { previous = await readFile(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous !== file.content) await writeFile(target, file.content, 'utf8');
  }
  return path;
}

/** @brief Bounded exact-input artifact cache. Every hit is verified and copied to a new owner-bound job.
 * @param root Private cache directory, separate from externally addressable job outputs.
 */
export function createBuildCache(root, { now = Date.now, maxEntries = 10, maxBytes = 256 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const key = (board, fqbn, files, fingerprint) => hash(JSON.stringify({ board, fqbn, fingerprint,
    files: [...files].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, content }) => [name, content]) }));
  const remove = async (id) => { entries.delete(id); await rm(ownedPath(root, id), { recursive: true, force: true }); };
  const prune = async () => {
    for (const [id, value] of entries) if (now() - value.created > 3600000) await remove(id);
    while (entries.size > maxEntries || [...entries.values()].reduce((sum, value) => sum + value.bytes, 0) > maxBytes)
      await remove(entries.keys().next().value);
  };
  return {
    key,
    async restore(id, output) {
      await prune();
      const entry = entries.get(id);
      if (!entry) return undefined;
      const verified = [];
      try {
        for (const file of entry.files) {
          const bytes = await readFile(ownedPath(root, id, file.name));
          if (bytes.length !== file.size || hash(bytes) !== file.digest) throw new Error('Cached artifact changed');
          verified.push([file.name, bytes]);
        }
      } catch { await remove(id); return undefined; }
      await mkdir(output, { recursive: true });
      for (const [name, bytes] of verified) await writeFile(ownedPath(output, name), bytes);
      entries.delete(id); entries.set(id, entry);
      return entry.result;
    },
    async store(id, output, result) {
      if (!/^[a-f0-9]{64}$/.test(id) || !result.success) return;
      const files = [];
      let total = 0;
      for (const entry of await readdir(output, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.name)) continue;
        const bytes = await readFile(ownedPath(output, entry.name));
        total += bytes.length;
        if (bytes.length > 32 * 1024 * 1024 || total > 64 * 1024 * 1024) return;
        files.push({ name: entry.name, size: bytes.length, digest: hash(bytes), bytes });
      }
      if (!files.some((file) => /\.(?:hex|bin)$/.test(file.name))) return;
      const path = ownedPath(root, id);
      await mkdir(path, { recursive: true });
      for (const file of files) await writeFile(ownedPath(path, file.name), file.bytes);
      entries.set(id, { created: now(), bytes: total, files: files.map(({ bytes, ...metadata }) => metadata), result });
      await prune();
    },
    async clear() { for (const id of [...entries.keys()]) await remove(id); },
  };
}
