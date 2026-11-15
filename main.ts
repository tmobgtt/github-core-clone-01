// The entry's lifecycle, and nothing else: this process is the forge's server, so it binds an
// ephemeral port, tells the env where it bound, and then stays up until the env says the
// trial is over. The surface itself lives in app.ts and the modules it wires together; this
// file only keeps the process alive and honest about the env's protocol:
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to register with,
//      so the process exits 1 at once rather than serving into the void.
//   2. listen(0) lets the kernel pick the port — never 8080, which the env owns.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The first register wins; a 409 means
//      another process already holds the slot and this one simply waits like any other.
//   4. GET $MAKEFUN_ENV_URL/done, polled with a short backoff, until it answers
//      {"done": true}. The process never exits before that answer.
//   5. Close the server and exit 0.
//
// main.ts imports the app and nothing else: no packages, no Node built-ins, no model calls.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff between polls: 250 ms doubling to a 2 s ceiling. */
function backoff(attempt: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

/** Register the bound port, retrying while the env is still coming up. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll the env's /done until it answers true; never returns before that. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll means "not done yet", never "give up".
    }
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  // A sandbox stops its containers with SIGTERM. Die cleanly on it — closing the listener
  // first — rather than being cut down mid-response; a truncated answer in the trial's last
  // moments would be scored as a failure the forge never made.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1_000).unref();
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered; holding until the env says done\n');
  await waitUntilDone();
  // The suite may hold keep-alive sockets open; close() alone would wait on them. Drop the
  // idle ones so the close completes and the process exits inside its budget.
  server.closeIdleConnections();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
