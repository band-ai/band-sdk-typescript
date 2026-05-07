/**
 * Reviewer agent — Codex side of the planner+reviewer pair.
 *
 * Reads `prompts/reviewer.md` (the reviewer's behavior guide), substitutes
 * the workspace path, and runs it as the agent's `customSection`. Codex
 * does the file work + shell commands; Thenvoi platform tools are exposed
 * via the standard MCP integration.
 *
 * Pair this with `planner-agent.ts` (Claude SDK) in another terminal,
 * pointing both at the same `WORKSPACE` directory so they share
 * `notes/plan.md` and `notes/review.md`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Agent,
  CodexAdapter,
  type CodexAdapterConfig,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadReviewerPrompt(workspace: string): Promise<string> {
  const raw = await readFile(path.join(__dirname, "prompts/reviewer.md"), "utf8");
  return raw.replace(/\/workspace\b/g, workspace);
}

interface ReviewerOptions {
  model?: string;
  workspace?: string;
  reasoningEffort?: CodexAdapterConfig["reasoningEffort"];
}

export async function createReviewerAgent(
  options: ReviewerOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const workspace =
    options.workspace ??
    process.env.WORKSPACE ??
    path.resolve(process.cwd(), ".coding-agents-workspace");

  const customSection = await loadReviewerPrompt(workspace);

  const adapter = new CodexAdapter({
    config: {
      model: options.model ?? process.env.REVIEWER_MODEL ?? "gpt-5.3-codex",
      cwd: workspace,
      // Reviewer is non-destructive in spirit but needs to write to
      // `notes/review.md`; keep `workspace-write`. Set approvalPolicy
      // to "never" so reviews aren't gated on a human Y/N.
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      reasoningEffort:
        options.reasoningEffort ??
        (process.env.REVIEWER_REASONING_EFFORT as CodexAdapterConfig["reasoningEffort"]) ??
        "high",
      enableExecutionReporting: true,
      emitThoughtEvents: true,
      enableLocalCommands: true,
      customSection,
    },
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "coding-reviewer",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the reviewer.");
  }

  // Allow loading under a different yaml key so people running multiple
  // reviewers (different models, different repos) don't have to clone
  // this file.
  const configKey = process.env.REVIEWER_AGENT_KEY ?? "reviewer";
  const config = loadAgentConfig(configKey);
  console.log("[reviewer] starting:", config.agentId);
  void createReviewerAgent({}, config).then((agent) => agent.run());
}
