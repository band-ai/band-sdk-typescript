/**
 * OpenCode adapter — bridge a running `opencode serve` instance into Thenvoi.
 *
 * OpenCode is a self-hosted "Claude Code-style" agent that exposes an HTTP
 * + SSE API. The adapter forwards each Thenvoi room message into an
 * OpenCode session, streams events (tool calls, approvals, output) back
 * into the room as Thenvoi events, and posts the final reply.
 *
 * You point this at any OpenCode server you've already started — see the
 * README for the install + serve commands.
 */
import {
  Agent,
  OpencodeAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { ConsoleLogger } from "@thenvoi/sdk/core";

interface OpencodeExampleOptions {
  /** Where the OpenCode server lives. Defaults to localhost on the standard port. */
  baseUrl?: string;
  /** OpenCode provider ID — set this if you've configured a non-default provider. */
  providerId?: string;
  /** OpenCode model ID. Default works for the bundled free model. */
  modelId?: string;
  /** OpenCode "agent" preset name, if you've defined one. */
  agent?: string;
  /** What to do when OpenCode asks for permission. `manual` waits for a human; `auto_accept` lets it proceed. */
  approvalMode?: "manual" | "auto_accept" | "auto_decline";
}

export function createOpencodeAgent(
  options: OpencodeExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new OpencodeAdapter({
    config: {
      baseUrl: options.baseUrl ?? "http://127.0.0.1:4096",
      providerId: options.providerId ?? "opencode",
      modelId: options.modelId ?? "minimax-m2.5-free",
      ...(options.agent ? { agent: options.agent } : {}),
      customSection: "You are a helpful assistant. Keep replies concise.",
      approvalMode: options.approvalMode ?? "manual",
    },
    // ConsoleLogger surfaces OpenCode's request/response cycle in stdout —
    // useful while wiring this up; swap for `NoopLogger` in production.
    logger: new ConsoleLogger(),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "opencode-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("opencode_agent");
  const approvalMode = (process.env.OPENCODE_APPROVAL_MODE ?? "manual") as
    | "manual"
    | "auto_accept"
    | "auto_decline";

  void createOpencodeAgent(
    {
      baseUrl: process.env.OPENCODE_BASE_URL,
      providerId: process.env.OPENCODE_PROVIDER_ID,
      modelId: process.env.OPENCODE_MODEL_ID,
      agent: process.env.OPENCODE_AGENT,
      approvalMode,
    },
    config,
  ).run();
}
