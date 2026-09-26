/**
 * Shared plumbing for live E2E scripts under tests/integration/*-live.ts:
 * provisioning/reaping disposable test agents on the real Band platform, a
 * pass/fail/assert reporter, and small polling helpers. Extracted from
 * core-retry-participant-live.ts so a second live script doesn't re-implement
 * the same primitives (mirrors tests/support's role for unit-test fakes).
 */
import { spawnSync } from "node:child_process";

import { BandClient } from "@band-ai/rest-client";

import { FernRestAdapter } from "../../../src/rest";
import { withTimeout } from "../../../src/adapters/shared/withTimeout";
import { TrafficLog } from "../../testUtils";

import type { BandLink } from "../../../src/platform/BandLink";
import type { PlatformEvent } from "../../../src/platform/events";

export const NAME_PREFIX = "e2e-ts-";
export const DEFAULT_REST_URL = "https://app.band.ai/";
const ORPHAN_MAX_AGE_MINUTES = 60;
const CLI_PROBE_TIMEOUT_MS = 10_000;

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface Reporter {
  pass(name: string): void;
  fail(name: string, error: string): void;
  assert(name: string, condition: boolean, errorMsg: string): void;
  /** Prints the `${passed}/${total} passed` summary and sets a failing exit code if any failed. */
  summarize(label: string): void;
}

export function createReporter(): Reporter {
  const results: TestResult[] = [];

  const pass = (name: string): void => {
    results.push({ name, passed: true });
    console.log(`  ✅ ${name}`);
  };

  const fail = (name: string, error: string): void => {
    results.push({ name, passed: false, error });
    console.log(`  ❌ ${name}: ${error}`);
  };

  const assert = (name: string, condition: boolean, errorMsg: string): void => {
    condition ? pass(name) : fail(name, errorMsg);
  };

  const summarize = (label: string): void => {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${label} ${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  };

  return { pass, fail, assert, summarize };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `predicate` until it returns true, throwing if `timeoutMs` elapses first. */
export async function waitUntil(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/** `waitUntil`, reported through `reporter` (pass/fail) instead of throwing on timeout. */
export async function assertEventually(
  reporter: Pick<Reporter, "pass" | "fail">,
  name: string,
  predicate: () => boolean,
  describeState: () => string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  try {
    await waitUntil(predicate, options);
    reporter.pass(name);
  } catch (error) {
    reporter.fail(name, `${describeState()} error=${error instanceof Error ? error.message : String(error)}`);
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required — see the calling script's header for the run command`);
  }
  return value;
}

export interface LiveEnv {
  restUrl: string;
  wsUrl: string | undefined;
  userApiKey: string;
  userClient: BandClient;
}

/** Reads the env vars every live script needs and builds a user-scoped REST client from them. */
export function loadLiveEnv(): LiveEnv {
  // `||`, not `??`: an unset GitHub Actions secret expands to "", which `??`
  // would pass through as a real URL.
  const restUrl = process.env.BAND_REST_URL || DEFAULT_REST_URL;
  const wsUrl = process.env.BAND_WS_URL || undefined;
  const userApiKey = requireEnv("BAND_API_KEY_USER");
  const userClient = new BandClient({ baseUrl: restUrl, apiKey: userApiKey });
  return { restUrl, wsUrl, userApiKey, userClient };
}

/** Why `<command> --version` failed, or null when the CLI is installed and runs. */
export function cliProbeFailure(command: string): string | null {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", timeout: CLI_PROBE_TIMEOUT_MS });
  if (probe.error) {
    return probe.error.message;
  }
  if (probe.signal) {
    return `terminated by ${probe.signal}`;
  }
  return probe.status === 0 ? null : `exited with status ${probe.status}`;
}

/** A REST client acting as the agent that owns `apiKey`. */
export function agentRest(restUrl: string, apiKey: string): FernRestAdapter {
  return new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey }));
}

/** An agent's REST client that records the events it posts, so a script waits on them instead of polling the room. */
export class EventRecordingRest extends FernRestAdapter {
  private readonly posted: string[] = [];
  private readonly traffic = new TrafficLog();

  public constructor(restUrl: string, apiKey: string) {
    super(new BandClient({ baseUrl: restUrl, apiKey }));
  }

  public override async createChatEvent(...args: Parameters<FernRestAdapter["createChatEvent"]>) {
    const result = await super.createChatEvent(...args);
    this.posted.push(args[1].content);
    this.traffic.record();
    return result;
  }

  /** The events posted so far that contain `text`, once there is at least one. */
  public async eventsContaining(text: string, timeoutMs = LIVE_EVENT_TIMEOUT_MS): Promise<string[]> {
    const matching = () => this.posted.filter((content) => content.includes(text));
    await withTimeout(this.traffic.until(() => matching().length > 0), timeoutMs, `no event containing: ${text}`);
    return matching();
  }
}

/** Posts `text` to the room as `rest`'s agent, @mentioning `recipient` so it is delivered to them. */
export async function sendMentionedMessage(
  rest: FernRestAdapter,
  roomId: string,
  recipient: ProvisionedAgent,
  text: string,
): Promise<void> {
  await rest.createChatMessage(roomId, {
    content: `@${recipient.name} ${text}`,
    mentions: [{ id: recipient.id, handle: recipient.name }],
  });
}

export interface ProvisionedAgent {
  id: string;
  name: string;
  apiKey: string;
}

export async function provisionAgent(
  userClient: BandClient,
  runId: string,
  testName: string,
  label: string,
): Promise<ProvisionedAgent> {
  const name = `${NAME_PREFIX}${testName}-${runId}-${label}`;
  const response = await userClient.humanApiAgents.registerMyAgent({
    agent: { name, description: `TS SDK ${testName} E2E (${label})` },
  });
  const agent = response.data.agent;
  const credentials = response.data.credentials;
  if (!agent?.id || !credentials?.api_key) {
    throw new Error(`registerMyAgent returned no agent id/credentials for "${label}"`);
  }
  return { id: agent.id, name, apiKey: credentials.api_key };
}

/**
 * Bulk-deletes chat rooms via the raw `/me/chats/bulk-delete` endpoint —
 * `@band-ai/rest-client` has no generated method for it yet. Replace this
 * with the generated client call once one ships. Enterprise-plan-gated on
 * some accounts, so callers should treat failure as non-fatal cleanup.
 */
export async function deleteRoomsBulk(restUrl: string, apiKey: string, roomIds: string[]): Promise<void> {
  if (roomIds.length === 0) {
    return;
  }
  const response = await fetch(new URL("api/v1/me/chats/bulk-delete", restUrl), {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: roomIds }),
  });
  if (!response.ok) {
    throw new Error(`bulk-delete rooms failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  console.log(`liveHarness Room bulk-delete job accepted: ${body?.data?.id} (status=${body?.data?.status})`);
}

/**
 * Force-deletes leftover `NAME_PREFIX`-named agents from a run that crashed
 * before its own `finally` reap ran (e.g. the process was killed). Never
 * touches an agent from the *current* run or anything younger than
 * `ORPHAN_MAX_AGE_MINUTES` (a concurrent run in flight).
 */
export async function sweepOrphans(userClient: BandClient, runId: string): Promise<void> {
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MINUTES * 60_000;
  const orphanIds: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 20; page++) {
    const response = await userClient.humanApiAgents.listMyAgents({ name: NAME_PREFIX, limit: 100, cursor });
    for (const candidate of response.data) {
      if (!candidate.name.startsWith(NAME_PREFIX)) continue; // name filter is a contains-match
      if (candidate.name.includes(`-${runId}-`)) continue; // never reap our own run
      const insertedAt = Date.parse(candidate.inserted_at);
      if (Number.isNaN(insertedAt) || insertedAt > cutoff) continue; // unknown age or too fresh — could be concurrent
      orphanIds.push(candidate.id);
    }
    cursor = response.metadata.next_cursor;
    if (!response.metadata.has_more || !cursor) break;
  }

  if (orphanIds.length === 0) {
    return;
  }
  console.log(`liveHarness Sweeping ${orphanIds.length} orphaned test agent(s) from a prior run...`);
  await Promise.all(
    orphanIds.map((id) =>
      userClient.humanApiAgents.deleteMyAgent(id, { force: true }).catch((err: unknown) => {
        console.warn(`liveHarness Failed to sweep orphan agent ${id}:`, err);
      }),
    ),
  );
}

/** Force-deletes provisioned agents and bulk-deletes provisioned rooms, tolerating individual failures. */
export async function reapProvisioned(
  userClient: BandClient,
  restUrl: string,
  userApiKey: string,
  provisioned: ProvisionedAgent[],
  roomIds: string[],
  logLabel: string,
): Promise<void> {
  console.log(`${logLabel} Reaping provisioned agents and rooms...`);
  await Promise.all([
    ...provisioned.map((agent) =>
      userClient.humanApiAgents.deleteMyAgent(agent.id, { force: true }).catch((err: unknown) => {
        console.warn(`${logLabel} Failed to reap agent ${agent.id}:`, err);
      }),
    ),
    deleteRoomsBulk(restUrl, userApiKey, roomIds).catch((err: unknown) => {
      console.warn(`${logLabel} Failed to bulk-delete rooms:`, err);
    }),
  ]);
}

export const LIVE_EVENT_TIMEOUT_MS = 180_000;

/** Reads the link until `predicate` matches, or `timeoutMs` elapses. */
export async function waitForEvent(
  link: BandLink,
  predicate: (event: PlatformEvent) => boolean,
  message: string,
  timeoutMs = LIVE_EVENT_TIMEOUT_MS,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  for (let event = await link.nextEvent(signal); event; event = await link.nextEvent(signal)) {
    if (predicate(event)) {
      return;
    }
  }
  throw new Error(message);
}

function flushOutput(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

/** Runs a live script's `main`, reports a failure under `label`, and exits once output is flushed. */
export function runLiveScript(label: string, main: () => Promise<void>): void {
  main()
    .catch((error) => {
      console.error(`${label} failed:`, error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await Promise.all([flushOutput(process.stdout), flushOutput(process.stderr)]);
      // A managed CLI child can keep Node alive after cleanup.
      process.exit(process.exitCode ?? 0);
    });
}
