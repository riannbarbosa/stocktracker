/* Stubs the global fetch so the service tests drive the real request, retry and
 * normalization code without touching the network. */

export interface FetchCall {
  url: string;
  headers: Headers;
}

export interface QueuedResponse {
  body?: unknown;
  status?: number;
}

export interface FetchStub {
  /** Every request made while the stub was installed, in order. */
  calls: FetchCall[];
  /** Reply with the same JSON body and status to every request. */
  reply: (body: unknown, status?: number) => void;
  /** Reply with one queued response per call; the last entry repeats. */
  replyEach: (responses: QueuedResponse[]) => void;
  /** Full control: derive the response from the url and the call index. */
  handle: (handler: (url: string, callIndex: number) => Response) => void;
  restore: () => void;
}

const realFetch = globalThis.fetch;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchInput = Parameters<typeof fetch>[0];

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function stubFetch(): FetchStub {
  const calls: FetchCall[] = [];
  let handler: (url: string, callIndex: number) => Response = () => jsonResponse({ results: [] });

  const stub: typeof fetch = async (input, init) => {
    calls.push({ url: requestUrl(input), headers: new Headers(init?.headers) });
    return handler(requestUrl(input), calls.length - 1);
  };

  globalThis.fetch = stub;

  return {
    calls,
    reply(body, status = 200) {
      handler = () => jsonResponse(body, status);
    },
    replyEach(responses) {
      handler = (_url, index) => {
        const next = responses[Math.min(index, responses.length - 1)];
        return jsonResponse(next?.body ?? {}, next?.status ?? 200);
      };
    },
    handle(next) {
      handler = next;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}
