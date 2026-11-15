// main.ts — the entrypoint: the forge server plus the trial lifecycle.
//
// The harness starts this program beside the env (the suite's own server)
// and drives the whole trial through two endpoints on it:
//
//   1. bind an ephemeral port, so the kernel picks a free one;
//   2. POST {"port": <that port>} to $MAKEFUN_ENV_URL/register, so the env
//      knows where to dial the forge;
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true};
//   4. close the server and exit 0.
//
// The env dials the address the register request came from, so the server
// must already be listening when it registers. A register or a poll that
// fails is retried with exponential backoff; the entry never exits before
// /done says true. With no MAKEFUN_ENV_URL there is no env to talk to, and
// the program exits 1 at once.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

/** First wait between done polls, in ms; doubles each poll up to DONE_POLL_MAX_MS. */
const DONE_POLL_FIRST_MS = 250;
/** Longest wait between done polls, in ms. */
const DONE_POLL_MAX_MS = 2_000;
/** How long one register or done request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 5_000;
/** First wait between register retries, in ms; doubles each retry up to REGISTER_RETRY_MAX_MS. */
const REGISTER_RETRY_FIRST_MS = 250;
/** Longest wait between register retries, in ms. */
const REGISTER_RETRY_MAX_MS = 2_000;
/**
 * How long registering is retried before the entry gives up. The env's boot
 * budget is 20 s, so a register later than that is useless anyway.
 */
const REGISTER_BUDGET_MS = 15_000;
/** Grace for the server to close once done, before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The next backoff step: doubling from `first`, capped at `max`. */
function backoffMs(attempt: number, first: number, max: number): number {
  return Math.min(max, first * 2 ** Math.max(0, attempt));
}

/**
 * Start the forge on an ephemeral port and return the port the kernel
 * picked. Never binds 8080: that is the env's port.
 */
async function listen(server: Server): Promise<number> {
  server.on('error', (err) => {
    process.stderr.write(`[entry] server error: ${messageOf(err)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server bound no TCP port');
  }
  return address.port;
}

/**
 * What one register attempt concluded: the env has the port; the env
 * refused the request itself (a malformed body, a wrong method — retrying
 * cannot fix it); or the attempt missed and is worth retrying.
 */
type RegisterOutcome = 'accepted' | 'contract-error' | 'retry';

/**
 * Tell the env which port the forge listens on. A 200 means this register
 * was accepted, a 409 means an earlier one already was (the env keeps the
 * first); both count as accepted. A 400 or 405 is a contract error, and
 * anything else — a network failure, another status — is a retryable miss.
 */
async function register(envUrl: string, port: number): Promise<RegisterOutcome> {
  try {
    const response = await fetch(new URL('/register', envUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    if (response.status === 200 || response.status === 409) return 'accepted';
    if (response.status === 400 || response.status === 405) {
      process.stderr.write(`[entry] register refused: HTTP ${response.status} ${text}\n`);
      return 'contract-error';
    }
    return 'retry';
  } catch (err) {
    process.stderr.write(`[entry] register failed: ${messageOf(err)}\n`);
    return 'retry';
  }
}

/**
 * Register, retrying with backoff until the env has the port, the env
 * refuses the request itself, or the budget runs out.
 */
async function registerWithRetries(envUrl: string, port: number): Promise<boolean> {
  const started = performance.now();
  let attempt = 0;
  for (;;) {
    const outcome = await register(envUrl, port);
    if (outcome === 'accepted') return true;
    if (outcome === 'contract-error') return false;
    if (performance.now() - started >= REGISTER_BUDGET_MS) return false;
    await sleep(backoffMs(attempt, REGISTER_RETRY_FIRST_MS, REGISTER_RETRY_MAX_MS));
    attempt += 1;
  }
}

/**
 * Poll GET /done until the env says the suite is over. A failed poll, a
 * slow answer, or a body that is not {"done": true} all mean "not yet":
 * wait with backoff and ask again. Never exits before the env says true.
 */
async function waitForDone(envUrl: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    let done = false;
    try {
      const response = await fetch(new URL('/done', envUrl), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      done = typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
    } catch (err) {
      process.stderr.write(`[entry] done poll failed: ${messageOf(err)}\n`);
    }
    if (done) return;
    await sleep(backoffMs(attempt, DONE_POLL_FIRST_MS, DONE_POLL_MAX_MS));
    attempt += 1;
  }
}

/** Stop serving and leave with code 0; the process exits anyway after a short grace. */
function shutdown(server: Server): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  if (envUrl === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
    process.exit(1);
  }
  const server = createApp();
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    process.stderr.write(`[entry] could not bind a port: ${messageOf(err)}\n`);
    process.exit(1);
  }
  process.stderr.write(`[entry] forge listening on port ${port}\n`);
  if (!(await registerWithRetries(envUrl, port))) {
    process.stderr.write('[entry] the env never accepted the register; giving up\n');
    process.exit(1);
  }
  process.stderr.write('[entry] registered; waiting for done\n');
  await waitForDone(envUrl);
  process.stderr.write('[entry] done; exiting\n');
  shutdown(server);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`[entry] ${messageOf(err)}\n`);
  process.exit(1);
}
