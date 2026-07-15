import assert from 'node:assert/strict';
import test from 'node:test';

import { readBoundedHttpBody, type HttpTransportResponse } from '../src/http-transport.js';
import { UnsafeCompletionError } from '../src/streaming.js';

function response(chunks: Array<string | Uint8Array>): HttpTransportResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    chunks: (async function* () {
      for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    })(),
  };
}

test('readBoundedHttpBody reconstructs fragmented UTF-8 response bytes', async () => {
  const encoded = Buffer.from('{"content":"🙂"}');
  const body = await readBoundedHttpBody(response([...encoded].map((byte) => Uint8Array.of(byte))), 128);
  assert.equal(body, '{"content":"🙂"}');
});

test('readBoundedHttpBody rejects overflow with metadata only', async () => {
  await assert.rejects(
    () => readBoundedHttpBody(response(['safe', 'secret-shaped-discard']), 4),
    (error: unknown) => {
      assert.ok(error instanceof UnsafeCompletionError);
      assert.equal(error.truncation[0]?.stream, 'http_body');
      assert.equal(error.truncation[0]?.limitBytes, 4);
      assert.doesNotMatch(error.message, /secret-shaped-discard/);
      return true;
    },
  );
});
