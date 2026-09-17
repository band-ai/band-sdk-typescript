/**
 * Live Tom & Jerry in one room across adapters (default: Anthropic Tom + Codex Jerry).
 *
 * Usage (from packages/sdk):
 *   pnpm run examples:config
 *   pnpm run examples:tom-jerry
 *
 * Requires: repo `.env.test` (Band user key, WS/REST, ANTHROPIC_API_KEY, OPENAI for Codex),
 *           distinct `tom_agent` / `jerry_agent` in `agent_config.yaml`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BandClient } from "@band-ai/rest-client";
import { load as loadYaml } from "js-yaml";

import { FernRestAdapter } from "../src/rest";
import { loadLiveEnv, sleep } from "../tests/integration/support/liveHarness";

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SDK_ROOT, "..", "..");
const TSX = path.join(SDK_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENV_FILE = path.join(REPO_ROOT, ".env.test");

const STARTUP_MS = 6000;
const JOIN_SETTLE_MS = 12_000;
const SCENARIO_MS = 240_000;
const POLL_MS = 3000;

interface AgentProfile {
  agent_id: string;
  api_key: string;
}

interface ScenarioOptions {
  tomScript: string;
  jerryScript: string;
  tomLabel: string;
  jerryLabel: string;
}

const DEFAULT_SCENARIO: ScenarioOptions = {
  tomScript: "examples/anthropic/03_tom_agent.ts",
  jerryScript: "examples/codex/03_jerry_agent.ts",
  tomLabel: "anthropic-tom",
  jerryLabel: "codex-jerry",
};

async function loadProfile(configKey: string): Promise<AgentProfile> {
  const raw = loadYaml(await readFile(path.join(SDK_ROOT, "agent_config.yaml"), "utf8")) as Record<
    string,
    AgentProfile | undefined
  >;
  const profile = raw[configKey];
  if (!profile?.agent_id || !profile?.api_key) {
    throw new Error(`agent_config.yaml missing ${configKey}.agent_id / api_key — run pnpm run examples:config`);
  }
  return profile;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (load via .env.test)`);
  }
  return value;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalProcessGroup(child, "SIGINT");
  await sleep(5000);
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalProcessGroup(child, "SIGTERM");
  await sleep(2000);
  signalProcessGroup(child, "SIGKILL");
}

async function startExample(relativeScript: string, logLabel: string): Promise<ChildProcess> {
  const scriptPath = path.join(SDK_ROOT, relativeScript);
  const logPath = path.join(os.tmpdir(), `band-tom-jerry-${logLabel}-${randomUUID().slice(0, 8)}.log`);
  const logFd = await import("node:fs/promises").then((fs) => fs.open(logPath, "w"));
  console.log(`tom-jerry starting ${logLabel} → ${relativeScript} (log: ${logPath})`);
  const child = spawn(process.execPath, ["--env-file", ENV_FILE, TSX, scriptPath], {
    cwd: SDK_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  await logFd.close();
  await sleep(STARTUP_MS);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${logLabel} exited during startup (see ${logPath})`);
  }
  return child;
}

async function participantHandle(
  rest: FernRestAdapter,
  roomId: string,
  agentId: string,
): Promise<string> {
  const roster = await rest.listChatParticipants(roomId);
  const member = roster.find((p) => p.id === agentId);
  const handle = member?.handle ?? member?.name;
  if (handle) {
    return handle;
  }
  const me = await rest.getAgentMe();
  if (!me.name) {
    throw new Error("getAgentMe returned no handle/name");
  }
  return me.name;
}

async function runScenario(options: ScenarioOptions): Promise<void> {
  requireEnv("ANTHROPIC_API_KEY");
  requireEnv("OPENAI_API_KEY");
  const tomProfile = await loadProfile("tom_agent");
  const jerryProfile = await loadProfile("jerry_agent");
  if (tomProfile.agent_id === jerryProfile.agent_id) {
    throw new Error("tom_agent and jerry_agent must be different Band agents (check examples:config / Python profiles)");
  }

  const { restUrl, userApiKey } = loadLiveEnv();
  const userRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: userApiKey }));
  const tomRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: tomProfile.api_key }));
  const jerryRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: jerryProfile.api_key }));
  /** Room setup via agent auth (dev platform rejects user createChat). */
  const hostRest = jerryRest;

  let tomChild: ChildProcess | null = null;
  let jerryChild: ChildProcess | null = null;
  const roomIds: string[] = [];

  try {
    tomChild = await startExample(options.tomScript, options.tomLabel);
    jerryChild = await startExample(options.jerryScript, options.jerryLabel);

    const chat = await hostRest.createChat();
    roomIds.push(chat.id);
    await hostRest.addChatParticipant(chat.id, { participantId: tomProfile.agent_id, role: "member" });
    console.log(`tom-jerry room ${chat.id} — waiting ${JOIN_SETTLE_MS / 1000}s for WS room join…`);
    await sleep(JOIN_SETTLE_MS);

    const tomHandle = await participantHandle(hostRest, chat.id, tomProfile.agent_id);
    const jerryHandle = await participantHandle(hostRest, chat.id, jerryProfile.agent_id);
    console.log(`tom-jerry Tom=@${tomHandle} (${options.tomLabel}) Jerry=@${jerryHandle} (${options.jerryLabel})`);

    const trigger = `@${tomHandle} Catch Jerry (@${jerryHandle})! Use band_lookup_peers to find him, then chase him with band_send_message.`;
    const triggerAt = new Date().toISOString();
    try {
      await userRest.createChatMessage(chat.id, {
        content: trigger,
        mentions: [{ id: tomProfile.agent_id, handle: tomHandle }],
      });
    } catch {
      await hostRest.createChatMessage(chat.id, {
        content: trigger,
        mentions: [{ id: tomProfile.agent_id, handle: tomHandle }],
      });
    }
    console.log("tom-jerry sent trigger (mention Tom only); polling room…");

    const pollStartedAt = Date.now();
    const deadline = pollStartedAt + SCENARIO_MS;
    let tomReplies = 0;
    let jerryReplies = 0;
    let tomToolCalls = 0;
    let crossMention = false;
    const seen = new Set<string>();
    let jerryNudgeSent = false;

    while (Date.now() < deadline) {
      let page;
      try {
        page = await userRest.listMessages({ chatId: chat.id, page: 1, pageSize: 100 });
      } catch {
        page = await hostRest.listMessages({ chatId: chat.id, page: 1, pageSize: 100 });
      }
      for (const message of page.data) {
        if (typeof message.inserted_at === "string" && message.inserted_at < triggerAt) {
          continue;
        }
        if (message.id && seen.has(message.id)) {
          continue;
        }
        if (message.id) {
          seen.add(message.id);
        }
        const content = message.content ?? "";
        const fromTom = message.sender_id === tomProfile.agent_id;
        const fromJerry = message.sender_id === jerryProfile.agent_id;
        const isChatText = message.message_type === "text" || message.message_type === "message";
        if (fromTom && isChatText) {
          tomReplies += 1;
        }
        if (fromJerry && isChatText) {
          jerryReplies += 1;
        }
        if (fromTom && message.message_type === "tool_call") {
          tomToolCalls += 1;
        }
        const mentionsJerry =
          content.toLowerCase().includes("jerry")
          || content.includes(jerryProfile.agent_id)
          || content.toLowerCase().includes(jerryHandle.toLowerCase());
        if (mentionsJerry && (fromTom || message.message_type === "tool_call" || message.message_type === "tool_result")) {
          crossMention = true;
        }
      }

      if (!jerryNudgeSent && tomReplies > 0 && jerryReplies === 0 && Date.now() - pollStartedAt > 90_000) {
        jerryNudgeSent = true;
        const nudge = `@${jerryHandle} Tom is chasing you — react in character!`;
        await hostRest.createChatMessage(chat.id, {
          content: nudge,
          mentions: [{ id: jerryProfile.agent_id, handle: jerryHandle }],
        });
        console.log("tom-jerry sent Jerry nudge (@mention Jerry for a Codex turn)");
      }

      const tomEngaged = tomReplies > 0 || tomToolCalls > 0;
      const jerryEngaged = jerryReplies > 0;
      const crossTalk = tomEngaged && jerryEngaged;
      const tomChasing = tomEngaged && (tomToolCalls > 0 || crossMention);

      if (crossTalk) {
        console.log(
          `tom-jerry PASS talk-flow: tomText=${tomReplies} jerryText=${jerryReplies} tomToolCalls=${tomToolCalls} crossMention=${crossMention}`,
        );
        return;
      }
      if (tomEngaged && crossMention && tomReplies >= 1) {
        console.log(
          `tom-jerry PASS partial (Tom engaged + referenced Jerry; Jerry silent): tomText=${tomReplies} tomToolCalls=${tomToolCalls}`,
        );
        return;
      }
      await sleep(POLL_MS);
    }

    const finalPage = await hostRest.listMessages({ chatId: chat.id, page: 1, pageSize: 30 });
    console.log(
      `tom-jerry INCOMPLETE after ${SCENARIO_MS / 1000}s: tomMessages=${tomReplies} jerryMessages=${jerryReplies} tomToolCalls=${tomToolCalls} crossMention=${crossMention}`,
    );
    console.log("tom-jerry last room events (newest last):");
    for (const message of [...finalPage.data].reverse().slice(0, 12)) {
      console.log(
        `  ${message.inserted_at} type=${message.message_type} sender=${message.sender_id?.slice(0, 8)}… ${(message.content ?? "").slice(0, 120)}`,
      );
    }
    process.exitCode = 1;
  } finally {
    if (tomChild) {
      await terminateProcess(tomChild);
    }
    if (jerryChild) {
      await terminateProcess(jerryChild);
    }
    if (roomIds.length > 0) {
      console.log(`tom-jerry room ${roomIds[0]} left for inspection (not bulk-deleted)`);
    }
  }
}

const tomScript = process.env.TOM_SCRIPT;
const jerryScript = process.env.JERRY_SCRIPT;
const scenario: ScenarioOptions =
  tomScript && jerryScript
    ? {
        tomScript,
        jerryScript,
        tomLabel: "tom",
        jerryLabel: "jerry",
      }
    : DEFAULT_SCENARIO;

void runScenario(scenario).catch((error) => {
  console.error("tom-jerry FAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
