import { connect } from 'node:http2';
import { spawn } from 'node:child_process';

const MAX_FRAME = 16 * 1024 * 1024;
const PREFIX = '/cc.arduino.cli.commands.v1.ArduinoCoreService/';
/** @brief Encode the bounded nonnegative varints used by Arduino CLI v1 RPC fields. */
function varint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid protobuf integer');
  const bytes = [];
  do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
/** @brief Minimal protocol encoder. Strings/messages are length-delimited; numbers are varints. */
export function proto(fields) {
  return Buffer.concat(fields.map(([number, value]) => {
    if (typeof value === 'number' || typeof value === 'boolean') return Buffer.concat([varint(number * 8), varint(Number(value))]);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  }));
}
/** @brief Decode only standard protobuf wire types, with lengths bounded by the gRPC message limit. */
export function protoFields(bytes) {
  if (bytes.length > MAX_FRAME) throw new Error('Compiler protobuf message exceeded limit');
  let offset = 0;
  const integer = () => {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('Truncated compiler protobuf');
      const next = bytes[offset++]; value += (next & 127) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error('Compiler protobuf integer exceeded safe range');
      if (!(next & 128)) return value;
      multiplier *= 128;
    }
    throw new Error('Invalid compiler protobuf varint');
  };
  const result = new Map();
  while (offset < bytes.length) {
    const tag = integer(), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field) throw new Error('Invalid compiler protobuf field');
    let value;
    if (wire === 0) value = integer();
    else if (wire === 2) {
      const length = integer();
      if (length > MAX_FRAME || offset + length > bytes.length) throw new Error('Truncated compiler protobuf field');
      value = bytes.subarray(offset, offset + length); offset += length;
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) throw new Error('Truncated compiler float');
      value = bytes.readFloatLE(offset); offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) throw new Error('Truncated compiler fixed integer');
      value = bytes.subarray(offset, offset + 8); offset += 8;
    } else throw new Error('Unsupported compiler protobuf wire type');
    result.set(field, value);
  }
  return result;
}

/** @brief Encode an uncompressed gRPC message. */
export function grpcFrame(bytes) {
  if (bytes.length > MAX_FRAME) throw new Error('Compiler request exceeded limit');
  const header = Buffer.alloc(5); header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

/** @brief Invoke one fixed Arduino RPC over a private loopback HTTP/2 endpoint, decoding streamed messages.
 * @param options Bounded duration and callback; no arbitrary URL is accepted.
 */
export function compilerRpc(endpoint, method, body, { timeoutMs = 600000, onMessage = () => {} } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !['Create', 'Init', 'Compile', 'Destroy'].includes(method)) throw new Error('Invalid compiler RPC destination');
  return new Promise((resolve, reject) => {
    const session = connect(endpoint);
    let request, pending = Buffer.alloc(0), settled = false, status, statusMessage = '';
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      request?.close(); session.close(); session.destroy();
      const code = Number(status ?? 2);
      if (!error && (!Number.isInteger(code) || code < 0 || code > 16)) error = new Error('Compiler RPC returned an invalid status');
      error ? reject(error) : resolve({ status: code, message: statusMessage });
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Compiler RPC timed out'), { status: 504, interrupted: true })), timeoutMs);
    session.on('error', finish);
    request = session.request({ ':method': 'POST', ':path': PREFIX + method, 'content-type': 'application/grpc', te: 'trailers', 'grpc-accept-encoding': 'identity' });
    const metadata = (headers) => {
      if (headers['grpc-status'] !== undefined) status = headers['grpc-status'];
      if (headers['grpc-message']) {
        try { statusMessage = decodeURIComponent(String(headers['grpc-message'])).slice(0, 4096); }
        catch { statusMessage = 'Compiler RPC failed'; }
      }
    };
    request.on('response', (headers) => {
      if (headers[':status'] !== 200) finish(new Error('Compiler RPC returned an invalid HTTP status'));
      metadata(headers);
    });
    request.on('trailers', metadata);
    request.on('error', finish);
    request.on('data', (chunk) => {
      if (settled) return;
      try {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5) {
          if (pending[0] !== 0) throw new Error('Compressed compiler RPC messages are unsupported');
          const length = pending.readUInt32BE(1);
          if (length > MAX_FRAME) throw new Error('Compiler RPC frame exceeded limit');
          if (pending.length < length + 5) break;
          onMessage(protoFields(pending.subarray(5, 5 + length)));
          pending = pending.subarray(5 + length);
        }
        if (pending.length > MAX_FRAME + 5) throw new Error('Compiler RPC buffer exceeded limit');
      } catch (error) { finish(error); }
    });
    request.on('end', () => finish(pending.length ? new Error('Compiler RPC ended with a truncated message') : undefined));
    request.end(grpcFrame(body));
  });
}

/** @brief Own an unmodified Arduino CLI daemon bound to an OS-selected private loopback port.
 * @details Wire definitions follow official CLI1.5.1 common/commands/compile.proto. No package dependency,
 * shell, public binding, daemonize flag or user-selected RPC method is used.
 */
export function createNativeCompiler(executable, configFile, { timeoutMs = 600000 } = {}) {
  let child, ready, fingerprint, stopping, shutdownFailed = false;
  const terminate = () => {
    const owned = child; child = undefined; ready = undefined;
    if (!owned?.pid || owned.exitCode !== null || owned.signalCode !== null) return stopping ?? Promise.resolve();
    // Never start a second daemon while the first compiler tree is still terminating.
    stopping = new Promise((resolve) => {
      let settled = false;
      const finish = (failed = false) => { if (settled) return; settled = true; shutdownFailed ||= failed; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => finish(true), 10000);
      owned.once('close', () => finish());
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { owned.kill(); } catch { finish(true); } });
      } else { try { owned.kill(); } catch { finish(true); } }
    });
    return stopping;
  };
  const ensure = () => {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const args = [...(configFile ? ['--config-file', configFile] : []), 'daemon', '--port', '0', '--no-color'];
      const owned = spawn(executable, args, { shell: false, windowsHide: true });
      child = owned;
      let text = '', resolved = false;
      const fail = (error) => { if (resolved) return; resolved = true; clearTimeout(timer); terminate(); reject(error); };
      const timer = setTimeout(() => fail(new Error('Local compiler daemon failed to start')), 10000);
      owned.on('error', fail);
      owned.on('exit', () => { if (!resolved) fail(new Error('Local compiler daemon exited during startup')); if (child === owned) { child = undefined; ready = undefined; } });
      owned.stdout.on('data', async (chunk) => {
        if (resolved) return;
        text += chunk.toString();
        if (text.length > 16384) return fail(new Error('Compiler startup log exceeded limit'));
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim().startsWith('{')) continue;
          let value;
          try { value = JSON.parse(line); } catch { continue; }
          const port = Number(value.Port);
          if (value.IP !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || port > 65535) continue;
          resolved = true; clearTimeout(timer);
          try {
            const endpoint = `http://127.0.0.1:${port}`;
            let instance;
            const created = await compilerRpc(endpoint, 'Create', proto([]), { timeoutMs: 10000, onMessage(fields) { instance = protoFields(fields.get(1)).get(1); } });
            if (created.status || !Number.isInteger(instance) || instance < 1) throw new Error('Compiler instance could not be created');
            const instanceMessage = proto([[1, instance]]);
            const initialized = await compilerRpc(endpoint, 'Init', proto([[1, instanceMessage]]), { timeoutMs: 30000, onMessage(fields) {
              if (fields.has(2)) { const error = protoFields(fields.get(2)); if (error.get(1)) throw new Error(`Compiler initialization failed: ${error.get(2)?.toString() ?? 'unknown error'}`); }
            } });
            if (initialized.status) throw new Error(initialized.message || 'Compiler initialization failed');
            resolve({ endpoint, instanceMessage });
          } catch (error) { terminate(); reject(error); }
          return;
        }
      });
      owned.stderr.on('data', () => {});
    });
    return ready;
  };
  const onExit = () => { void terminate(); };
  process.once('exit', onExit);
  return {
    async compile(args, options = {}) {
      if (fingerprint !== undefined && options.fingerprint !== fingerprint) await terminate();
      if (stopping) { await stopping; stopping = undefined; }
      if (shutdownFailed) throw Object.assign(new Error('Previous compiler could not be stopped; restart the companion'), { interrupted: false });
      fingerprint = options.fingerprint;
      let endpoint, instanceMessage;
      try { ({ endpoint, instanceMessage } = await ensure()); }
      catch (error) { error.interrupted = false; throw error; }
      const flag = (name) => args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1];
      const fields = [[1, instanceMessage], [2, flag('--fqbn')], [3, args.at(-1)], [7, flag('--build-path')], [9, flag('--warnings') ?? 'all'], [14, Number(flag('--jobs') ?? 0)], [18, flag('--output-dir')], [23, false]];
      let stdout = '', stderr = '', size = 0;
      try {
        const result = await compilerRpc(endpoint, 'Compile', proto(fields), { timeoutMs, onMessage(message) {
          for (const [field, value] of [[1, message.get(1)], [2, message.get(2)]]) if (value) {
            size += value.length;
            if (size > 2_000_000) throw new Error('Compiler log exceeded limit');
            if (field === 1) stdout += value.toString(); else stderr += value.toString();
          }
          if (message.has(3)) {
            const progress = protoFields(message.get(3));
            const percent = progress.get(4);
            if (typeof percent === 'number' && Number.isFinite(percent)) options.onProgress?.({ percent: Math.min(100, Math.max(0, percent)), stage: 'Compiling' });
          }
        } });
        return { code: result.status ? 1 : 0, stdout, stderr: stderr + (result.status ? `\n${result.message || 'Compilation failed'}` : '') };
      } catch (error) { await terminate(); error.interrupted = true; throw error; }
    },
    invalidate: terminate,
    close() { process.off('exit', onExit); return terminate(); },
  };
}
