import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http2';
import { compilerRpc, grpcFrame, proto, protoFields } from '../src/compiler-rpc.mjs';

const progressMessage = (percent) => {
  const value = Buffer.alloc(5); value[0] = 4 * 8 + 5; value.writeFloatLE(percent, 1);
  return proto([[3, value]]);
};

test('native compiler RPC consumes fragmented actual protobuf progress, stdout and status trailers', async () => {
  const server = createServer();
  let request;
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      request = { path: headers[':path'], fields: protoFields(Buffer.concat(chunks).subarray(5)) };
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      const data = Buffer.concat([grpcFrame(progressMessage(24.5)), grpcFrame(proto([[1, Buffer.from('genuine protocol test double')]])), grpcFrame(progressMessage(100))]);
      stream.write(data.subarray(0, 3));
      stream.write(data.subarray(3, 11));
      stream.end(data.subarray(11));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const seen = [];
    let output = '';
    const result = await compilerRpc(`http://127.0.0.1:${server.address().port}`, 'Compile', proto([[2, 'esp32:esp32:esp32s3'], [14, 8]]), { onMessage(fields) {
      if (fields.has(3)) seen.push(protoFields(fields.get(3)).get(4));
      if (fields.has(1)) output += fields.get(1).toString();
    } });
    assert.equal(result.status, 0);
    assert.deepEqual(seen, [24.5, 100]);
    assert.equal(output, 'genuine protocol test double');
    assert.match(request.path, /ArduinoCoreService\/Compile$/);
    assert.equal(request.fields.get(2).toString(), 'esp32:esp32:esp32s3');
    assert.equal(request.fields.get(14), 8);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('RPC rejects truncated/oversized/compressed frames and preserves compiler failure status', async () => {
  const responses = [Buffer.from([0, 0, 0, 0, 8, 10]), Buffer.from([0, 127, 255, 255, 255]), Buffer.from([1, 0, 0, 0, 0])];
  for (const response of responses) {
    const server = createServer();
    server.on('stream', (stream) => {
      stream.on('data', () => {});
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
      stream.end(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try { await assert.rejects(compilerRpc(`http://127.0.0.1:${server.address().port}`, 'Create', proto([])), /truncated|limit|Compressed/i); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  }
  const server = createServer();
  server.on('stream', (stream) => {
    stream.on('data', () => {});
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '3', 'grpc-message': 'Invalid%20source' });
    stream.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await compilerRpc(`http://127.0.0.1:${server.address().port}`, 'Compile', proto([]));
    assert.deepEqual(result, { status: 3, message: 'Invalid source' });
    assert.throws(() => compilerRpc('http://evil.example:50051', 'Compile', proto([])), /destination/);
    assert.throws(() => compilerRpc(`http://127.0.0.1:${server.address().port}`, 'Upload', proto([])), /destination/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('RPC bounds silent streams with a real request timeout', async () => {
  const server = createServer();
  server.on('stream', (stream) => stream.on('data', () => {}));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(compilerRpc(`http://127.0.0.1:${server.address().port}`, 'Compile', proto([]), { timeoutMs: 30 }), /timed out/); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});
