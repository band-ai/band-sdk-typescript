export interface FakeResponseSpec {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RecordedFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface FakeFetchServer {
  fetch: typeof fetch;
  calls: RecordedFetchCall[];
}

/**
 * Stands in for `fetch` at the exact seam `@band-ai/rest-client` exposes for
 * injection (`BaseClientOptions.fetch`), so a test can drive the *real*
 * generated client — including its retry/backoff — instead of mocking the
 * client method itself.
 */
export function createFakeFetchServer(responses: FakeResponseSpec[]): FakeFetchServer {
  const queue = [...responses];
  const calls: RecordedFetchCall[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headerSource = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers: Record<string, string> = {};
    new Headers(headerSource).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, method, headers });

    const next = queue.shift();
    if (!next) {
      throw new Error(
        `fakeFetchServer: no response queued for call #${calls.length} (${method} ${url})`,
      );
    }

    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}
