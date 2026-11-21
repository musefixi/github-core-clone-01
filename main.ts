// Entry point for the forge.
//
// The grading environment starts this process beside its suite and talks
// to it over HTTP. The contract between the two processes is small:
//
//   1. MAKEFUN_ENV_URL names the environment's origin.
//   2. We start the forge on an ephemeral port and announce that port with
//      POST {MAKEFUN_ENV_URL}/register and a JSON body of { "port": n }.
//   3. The suite then drives the forge as a client for as long as it needs.
//   4. We poll GET {MAKEFUN_ENV_URL}/done; once it answers { "done": true }
//      the trial is over, so we stop serving and exit with status 0.
//
// The bearer token the API surfaces demand is read by app.ts itself from
// MAKEFUN_SHOP_TOKEN, so nothing about authentication belongs here.

import type { AddressInfo } from 'node:net';

import { createApp } from './app.ts';

/** Name of the variable that carries the environment's origin. */
const ENV_URL_VAR = 'MAKEFUN_ENV_URL';
/** Route on the environment that takes our port announcement. */
const REGISTER_ROUTE = '/register';
/** Route on the environment that reports whether the trial has ended. */
const DONE_ROUTE = '/done';

/** Pause between two registration attempts while the environment boots. */
const REGISTER_PAUSE_MS = 250;
/** Registration attempts before giving up; the suite grants a boot window
 *  of about twenty seconds, and this many tries spans a little beyond it. */
const REGISTER_ATTEMPTS = 96;
/** Pause between two polls of the done route. */
const DONE_POLL_MS = 250;

/** Resolve after `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Write one diagnostic line to stderr. */
function complain(message: string): void {
  process.stderr.write(`forge entry: ${message}\n`);
}

/** The environment's origin with any trailing slashes stripped, or null
 *  when the variable is unset or blank. */
function environmentOrigin(): string | null {
  const raw = process.env[ENV_URL_VAR];
  if (raw === undefined || raw.trim() === '') return null;
  return raw.replace(/\/+$/, '');
}

/** One registration attempt. Resolves true once the environment holds our
 *  port: a 409 answer means an earlier attempt of ours landed even though
 *  its response never reached us, which is success for our purposes. */
async function announcePort(origin: string, port: number): Promise<boolean> {
  try {
    const reply = await fetch(`${origin}${REGISTER_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    await reply.arrayBuffer().catch(() => undefined);
    return reply.ok || reply.status === 409;
  } catch {
    return false;
  }
}

/** Register, retrying while the environment finishes coming up. */
async function registerWithRetry(origin: string, port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    if (await announcePort(origin, port)) return true;
    if (attempt < REGISTER_ATTEMPTS) await pause(REGISTER_PAUSE_MS);
  }
  return false;
}

/** Ask the environment whether the trial has ended. A transport failure
 *  counts as "not yet": the poll loop simply asks again. */
async function trialFinished(origin: string): Promise<boolean> {
  try {
    const reply = await fetch(`${origin}${DONE_ROUTE}`);
    if (!reply.ok) return false;
    const body: unknown = await reply.json();
    return (
      typeof body === 'object' &&
      body !== null &&
      (body as { done?: unknown }).done === true
    );
  } catch {
    return false;
  }
}

/** Poll the done route until the environment calls the trial over. */
async function serveUntilDone(origin: string): Promise<void> {
  while (!(await trialFinished(origin))) {
    await pause(DONE_POLL_MS);
  }
}

/** Run the lifecycle described at the top of this file. */
async function run(): Promise<number> {
  const origin = environmentOrigin();
  if (origin === null) {
    complain(`${ENV_URL_VAR} is not set, so there is no environment to register with`);
    return 1;
  }

  const forge = createApp();

  // The pod may signal us at teardown. Stop serving and leave cleanly
  // rather than dying in the middle of a request.
  const onSignal = (): void => {
    forge.close();
    forge.closeAllConnections?.();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      resolve();
    });
  });
  const { port } = forge.address() as AddressInfo;

  if (!(await registerWithRetry(origin, port))) {
    complain(`the environment at ${origin} never accepted our registration`);
    forge.close();
    return 1;
  }

  await serveUntilDone(origin);

  // The trial is over: stop listening and drop whatever connections the
  // suite still holds, so nothing keeps this process alive.
  forge.close();
  forge.closeAllConnections?.();
  return 0;
}

process.exit(await run());
