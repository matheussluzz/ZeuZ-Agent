import {
  BoundedByteAccumulator,
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  UnsafeCompletionError,
} from './streaming.js';

export interface HttpRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpTransportResponse {
  ok: boolean;
  status: number;
  statusText: string;
  chunks: AsyncIterable<Uint8Array>;
}

export type HttpTransport = (input: HttpRequestInput) => Promise<HttpTransportResponse>;

async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body) {
    for await (const chunk of response.body) yield chunk;
    return;
  }
  yield new Uint8Array(await response.arrayBuffer());
}

export const defaultHttpTransport: HttpTransport = async (input) => {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    chunks: responseChunks(response),
  };
};

export async function readBoundedHttpBody(
  response: HttpTransportResponse,
  limitBytes = DEFAULT_HTTP_BODY_LIMIT_BYTES,
): Promise<string> {
  const accumulator = new BoundedByteAccumulator('http_body', limitBytes);
  for await (const chunk of response.chunks) accumulator.append(chunk);
  const truncation = accumulator.metadata();
  if (truncation) throw new UnsafeCompletionError([truncation]);
  return accumulator.value();
}
