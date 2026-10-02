/**
 * The live run every toolkit resource belongs to: the platform env, and the
 * run id stamped into every provisioned name so orphan sweeps never touch it.
 * Orphans from an earlier interrupted run are swept once, on first use.
 */
import { randomUUID } from "node:crypto";

import { onTestFinished } from "vitest";

import { loadLiveEnv, sweepOrphans, type LiveEnv } from "../../integration/support/liveHarness";

export interface LiveRun {
  env: LiveEnv;
  runId: string;
}

let current: Promise<LiveRun> | undefined;

export function liveRun(): Promise<LiveRun> {
  current ??= start();
  return current;
}

async function start(): Promise<LiveRun> {
  const env = loadLiveEnv();
  const runId = randomUUID().slice(0, 8);
  await sweepOrphans(env.userClient, runId);
  return { env, runId };
}

/** Logs a teardown failure instead of throwing it: cleanup must never fail a test. */
export function warnTeardown(what: string): (error: unknown) => void {
  return (error) => console.warn(`baseline teardown: ${what}:`, error);
}

/**
 * Releases `resource` once, at its `await using` scope or when the test ends,
 * whichever comes first. Vitest abandons a timed-out test mid-await, so only
 * the test-end hook releases what that test held.
 */
export function releasedWithTest<T extends AsyncDisposable>(resource: T): T {
  const release = resource[Symbol.asyncDispose].bind(resource);
  let released: PromiseLike<void> | undefined;
  Object.defineProperty(resource, Symbol.asyncDispose, { value: () => (released ??= release()) });
  try {
    onTestFinished(() => resource[Symbol.asyncDispose]());
  } catch (error) {
    // Its test already ended, so no hook will ever release it.
    void resource[Symbol.asyncDispose]();
    throw error;
  }
  return resource;
}
