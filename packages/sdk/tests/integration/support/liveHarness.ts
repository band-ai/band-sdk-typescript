/**
 * Shared plumbing for live runs against the real Band platform — the baseline
 * suite (tests/baseline) and the operator scripts under scripts/:
 * provisioning/reaping disposable test agents and loading the live env
 * (mirrors tests/support's role for unit-test fakes).
 */
import { spawnSync } from "node:child_process";

import { BandClient } from "@band-ai/rest-client";

import { FernRestAdapter } from "../../../src/rest";

export const NAME_PREFIX = "e2e-ts-";
export const DEFAULT_REST_URL = "https://app.band.ai/";
const ORPHAN_MAX_AGE_MINUTES = 60;
const CLI_PROBE_TIMEOUT_MS = 10_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
