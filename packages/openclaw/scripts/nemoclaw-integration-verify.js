#!/usr/bin/env node
import { ThenvoiLink } from "@thenvoi/sdk";
import { RoomPresence } from "@thenvoi/sdk/runtime";
import {
  DEFAULT_REST_URL,
  DEFAULT_SANDBOX,
  DEFAULT_WS_URL,
  checkContextManifestTools,
  checkGeneratedContext,
  checkNemoclawSandbox,
  contextDir,
  redact,
  requireValue,
} from "./nemoclaw-integration-common.js";

function parseArgs(argv) {
  const opts = {
    sandbox: DEFAULT_SANDBOX,
    context: undefined,
    room: undefined,
    timeoutMs: 120_000,
    intervalMs: 2_000,
    skipNemoclaw: false,
    skipRoom: false,
    restUrl: process.env.THENVOI_REST_URL ?? DEFAULT_REST_URL,
    wsUrl: process.env.THENVOI_WS_URL ?? DEFAULT_WS_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--sandbox") opts.sandbox = requireValue(argv, ++i, arg);
    else if (arg === "--context") opts.context = requireValue(argv, ++i, arg);
    else if (arg === "--room") opts.room = requireValue(argv, ++i, arg);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(requireValue(argv, ++i, arg));
    else if (arg === "--interval-ms") opts.intervalMs = Number(requireValue(argv, ++i, arg));
    else if (arg === "--rest-url") opts.restUrl = requireValue(argv, ++i, arg);
    else if (arg === "--ws-url") opts.wsUrl = requireValue(argv, ++i, arg);
    else if (arg === "--skip-nemoclaw") opts.skipNemoclaw = true;
    else if (arg === "--skip-room") opts.skipRoom = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1_000) throw new Error("--timeout-ms must be at least 1000");
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < 250) throw new Error("--interval-ms must be at least 250");
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run nemoclaw:integration:verify -- --sandbox band-integration --room <room-id> [--skip-room]\n\nVerifies the credentialed Band/NemoClaw integration path. For full room proof, start this command, send the printed nonce prompt in the Band room with an explicit @mention of the configured agent, and wait for the verifier to observe an agent reply that includes the nonce.`);
}

async function layer(name, fn) {
  const startedAt = Date.now();
  try {
    const evidence = await fn();
    return { layer: name, status: "pass", durationMs: Date.now() - startedAt, evidence };
  } catch (error) {
    return { layer: name, status: "fail", durationMs: Date.now() - startedAt, message: redact(error) };
  }
}

function blockedLayer(name, reason) {
  return { layer: name, status: "blocked", durationMs: 0, message: reason };
}

function checkEnv() {
  const missing = ["THENVOI_API_KEY", "THENVOI_AGENT_ID"].filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  return { required: ["THENVOI_API_KEY", "THENVOI_AGENT_ID"] };
}

function checkManifestTools(opts) {
  return checkContextManifestTools(contextDir(opts));
}

function checkNemoclaw(opts) {
  if (opts.skipNemoclaw) return { skipped: true, reason: "--skip-nemoclaw" };
  return checkNemoclawSandbox(opts.sandbox);
}

function createLink(opts) {
  return new ThenvoiLink({
    agentId: process.env.THENVOI_AGENT_ID,
    apiKey: process.env.THENVOI_API_KEY,
    restUrl: opts.restUrl,
    wsUrl: opts.wsUrl,
  });
}

async function checkRest(link) {
  const agent = await link.rest.getAgentMe();
  return { agentId: agent.id, agentName: agent.name ?? null, agentHandle: agent.handle ?? null };
}

async function checkPresence(opts) {
  const link = createLink(opts);
  const presence = new RoomPresence({ link, autoSubscribeExistingRooms: true });
  try {
    await link.connect();
    await presence.start();
    await delay(Math.min(2_000, opts.timeoutMs));
    return { connected: link.isConnected(), rooms: presence.rooms?.size ?? 0 };
  } finally {
    await presence.stop().catch(() => undefined);
    await link.disconnect().catch(() => undefined);
  }
}

async function checkRoomReply(opts, agent) {
  if (opts.skipRoom) return { skipped: true, reason: "--skip-room" };
  if (!opts.room) throw new Error("--room is required unless --skip-room is set");

  const link = createLink(opts);
  const seenBefore = await listMessageIds(link, opts.room);
  const nonce = `band-nemoclaw-integration-${Date.now()}`;
  const deadline = Date.now() + opts.timeoutMs;
  const mention = agent.agentHandle ? `@${String(agent.agentHandle).replace(/^@/, "")}` : "<mention the configured Band agent>";

  console.error(
    `Waiting for a new Band-visible agent reply in room ${opts.room}. In Band, send a message that mentions the agent, for example: ${mention} Reply with ${nonce}`,
  );
  while (Date.now() < deadline) {
    const messages = await listMessages(link, opts.room);
    const reply = messages.find((message) => {
      const id = String(message.id ?? "");
      const senderId = String(message.sender_id ?? message.senderId ?? "");
      const content = String(message.content ?? "");
      return id && !seenBefore.has(id) && senderId === agent.agentId && content.includes(nonce);
    });
    if (reply) return { room: opts.room, replyMessageId: reply.id, senderId: agent.agentId, nonceMatched: true };
    await delay(opts.intervalMs);
  }

  throw new Error(
    `timed out after ${opts.timeoutMs}ms waiting for a new agent reply in room ${opts.room} containing the nonce ${nonce}; make sure the Band message explicitly @mentions the configured agent`,
  );
}

async function listMessageIds(link, room) {
  const messages = await listMessages(link, room);
  return new Set(messages.map((message) => String(message.id ?? "")).filter(Boolean));
}

async function listMessages(link, room) {
  if (typeof link.rest.listMessages !== "function") throw new Error("Band REST adapter does not expose listMessages");
  const response = await link.rest.listMessages({ chatId: room, page: 1, pageSize: 50 });
  return Array.isArray(response.data) ? response.data : [];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = [];
  results.push(await layer("generated_context", () => checkGeneratedContext(opts)));
  results.push(await layer("manifest_tools", () => checkManifestTools(opts)));
  results.push(await layer("nemoclaw_status", () => checkNemoclaw(opts)));

  const credentialResult = await layer("band_credentials", () => checkEnv());
  results.push(credentialResult);
  if (credentialResult.status === "pass") {
    const link = createLink(opts);
    const restResult = await layer("band_rest_getAgentMe", () => checkRest(link));
    results.push(restResult);
    results.push(await layer("band_websocket_presence", () => checkPresence(opts)));
    if (restResult.status === "pass") {
      results.push(await layer("band_room_reply", () => checkRoomReply(opts, restResult.evidence)));
    } else {
      results.push(blockedLayer("band_room_reply", "Band agent identity is required before the room reply check can run"));
    }
  } else {
    const reason = "Band credentials are required before live Band REST, WebSocket, or room checks can run";
    results.push(blockedLayer("band_rest_getAgentMe", reason));
    results.push(blockedLayer("band_websocket_presence", reason));
    results.push(blockedLayer("band_room_reply", reason));
  }

  const report = { mode: "live", sandbox: opts.sandbox, room: opts.room ?? null, results };
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => result.status === "fail" || result.status === "blocked")) process.exit(1);
}

try {
  await main();
} catch (error) {
  console.error(redact(error));
  process.exit(1);
}
