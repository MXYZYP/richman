import { pathToFileURL } from 'node:url';
import { startProductionServer } from '../apps/server/src/production';

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export const FETCH_TIMEOUT_ERROR_NAME = 'TimeoutError' as const;

export async function fetchProductionClient(
  url: string,
  fetchClient: typeof fetch = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    const err = new Error(`fetch timed out after ${timeoutMs}ms`);
    err.name = FETCH_TIMEOUT_ERROR_NAME;
    controller.abort(err);
  }, timeoutMs);

  try {
    const response = await fetchClient(url, { signal: controller.signal });

    if (response.status !== 200) {
      throw new Error(`Expected client root to return 200, received ${response.status}.`);
    }

    const html = await readResponseBody(response, controller.signal);
    if (!html.includes('<!DOCTYPE html>')) {
      throw new Error('Expected client root to return an HTML document.');
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
  const body = response.text();

  let abortListener: (() => void) | undefined;
  const timedOut = new Promise<never>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    abortListener = () => reject(signal.reason);
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([body, timedOut]);
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

async function main(): Promise<void> {
  const server = await startProductionServer(0);

  try {
    await fetchProductionClient(`http://127.0.0.1:${server.port}/`);
  } finally {
    await server.close();
    await server.close();
  }

  console.log('smoke ok');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    console.error('Production smoke test failed:', error);
    process.exitCode = 1;
  });
}
