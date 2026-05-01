/**
 * Planner agent — Claude SDK side of the planner+reviewer pair.
 *
 * Reads `prompts/planner.md` (the planner's behavior guide) at startup,
 * substitutes the configured workspace path into it, and runs the
 * resulting prompt as the agent's `customSection`. The Claude Agent SDK
 * does the actual file work; the Thenvoi MCP tools are exposed alongside
 * so the agent can `thenvoi_send_message`, `thenvoi_add_participant`, etc.
 *
 * Pair this with `reviewer-agent.ts` (Codex) in another terminal pointing
 * at the same `WORKSPACE` directory.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Agent,
  ClaudeSDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Read the planner prompt from disk and rewrite the placeholder
 * `/workspace/...` paths to the user's actual workspace. The prompt file
 * stays portable — nothing in it assumes a specific machine layout.
 */
async function loadPlannerPrompt(workspace: string): Promise<string> {
  const raw = await readFile(path.join(__dirname, "prompts/planner.md"), "utf8");
  return raw.replace(/\/workspace\b/g, workspace);
}

interface PlannerOptions {
  model?: string;
  workspace?: string;
}

export async function createPlannerAgent(
  options: PlannerOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  // Workspace resolution: explicit option > WORKSPACE env > local default.
  // Both planner and reviewer must pick the same path; the README spells
  // out the recommended setup.
  const workspace =
    options.workspace ??
    process.env.WORKSPACE ??
    path.resolve(process.cwd(), ".coding-agents-workspace");

  const customSection = await loadPlannerPrompt(workspace);

  const adapter = new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-6",
    cwd: workspace,
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    customSection,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "coding-planner",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Set ANTHROPIC_API_KEY to run the planner.");
  }

  const config = loadAgentConfig("planner");
  console.log("[planner] starting:", config.agentId);
  void createPlannerAgent({}, config).then((agent) => agent.run());
}
