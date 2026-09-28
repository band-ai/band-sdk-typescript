/**
 * One `registerAdapter` per framework adapter: what it needs and how to build
 * a helpful agent from a steering prompt. Import this module for its
 * registration side effect before querying the registry.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AnthropicAdapter,
  ClaudeSDKAdapter,
  CodexAdapter,
  CopilotACPAdapter,
  CursorACPAdapter,
  DEFAULT_COPILOT_ACP_COMMAND,
  DEFAULT_CURSOR_ACP_COMMAND,
  DEFAULT_KIRO_ACP_COMMAND,
  DEFAULT_OMP_ACP_COMMAND,
  GeminiAdapter,
  GoogleADKAdapter,
  KiroACPAdapter,
  LettaAdapter,
  OmpACPAdapter,
  OpenAIAdapter,
  OpencodeAdapter,
  ParlantAdapter,
} from "../../../src/adapters";
import { registerAdapter, type AdapterId, type Dep } from "./registry";

const ANTHROPIC_MODEL = "claude-haiku-4-5";
const GEMINI_MODEL = "gemini-2.5-flash";
const OPENAI_MODEL = "gpt-5.2";
const ANTHROPIC_KEY: Dep = { kind: "envVar", name: "ANTHROPIC_API_KEY" };
const GEMINI_KEY: Dep = { kind: "envVar", name: "GEMINI_API_KEY" };
const ACP_SDK: Dep = { kind: "peerPackage", name: "@agentclientprotocol/sdk" };

/** A builder for an adapter that cannot run yet; it names why instead of half-building one. */
function unbuildable(id: AdapterId, reason: string): () => never {
  return () => {
    throw new Error(`the ${id} adapter cannot be built: ${reason}`);
  };
}

registerAdapter("anthropic", {
  requires: [ANTHROPIC_KEY, { kind: "peerPackage", name: "@anthropic-ai/sdk" }],
  supports: [],
  build: ({ prompt }) => new AnthropicAdapter({ anthropicModel: ANTHROPIC_MODEL, systemPrompt: prompt }),
});

registerAdapter("claude-sdk", {
  requires: [ANTHROPIC_KEY, { kind: "peerPackage", name: "@anthropic-ai/claude-agent-sdk" }],
  supports: [],
  build: ({ prompt, workDir }) =>
    new ClaudeSDKAdapter({ model: ANTHROPIC_MODEL, customSection: prompt, cwd: workDir }),
});

registerAdapter("codex", {
  requires: [{ kind: "peerPackage", name: "@openai/codex-sdk" }, { kind: "cli", command: "codex" }],
  supports: [],
  pending: "needs Codex CLI authentication provisioned in CI",
  build: ({ prompt, workDir }) =>
    new CodexAdapter({ config: { cwd: workDir, customSection: prompt, approvalPolicy: "never" } }),
});

registerAdapter("copilot-acp", {
  requires: [
    ACP_SDK,
    { kind: "cli", command: DEFAULT_COPILOT_ACP_COMMAND[0] },
    // A hosted Copilot token, or the BYOK provider CI configures.
    { kind: "anyEnvVar", names: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_PROVIDER_BASE_URL"] },
  ],
  supports: [],
  build: ({ prompt, workDir }) => new CopilotACPAdapter({ cwd: workDir, customSection: prompt }),
});

registerAdapter("cursor-acp", {
  requires: [ACP_SDK, { kind: "cli", command: DEFAULT_CURSOR_ACP_COMMAND[0] }, { kind: "envVar", name: "CURSOR_API_KEY" }],
  supports: ["approvals"],
  pending: "needs the Cursor agent CLI and a CURSOR_API_KEY provisioned in CI",
  build: ({ prompt, workDir }) =>
    new CursorACPAdapter({ cwd: workDir, customSection: prompt, apiKey: process.env.CURSOR_API_KEY }),
});

registerAdapter("gemini", {
  requires: [GEMINI_KEY, { kind: "peerPackage", name: "@google/genai" }],
  supports: [],
  build: ({ prompt }) => new GeminiAdapter({ geminiModel: GEMINI_MODEL, systemPrompt: prompt }),
});

registerAdapter("google-adk", {
  requires: [GEMINI_KEY, { kind: "peerPackage", name: "@google/adk" }],
  supports: [],
  build: ({ prompt }) => new GoogleADKAdapter({ model: GEMINI_MODEL, systemPrompt: prompt }),
});

registerAdapter("kiro-acp", {
  requires: [ACP_SDK, { kind: "cli", command: DEFAULT_KIRO_ACP_COMMAND[0] }, { kind: "envVar", name: "KIRO_API_KEY" }],
  supports: [],
  pending: "needs the Kiro CLI and a KIRO_API_KEY provisioned in CI",
  build: ({ prompt, workDir }) => new KiroACPAdapter({ cwd: workDir, customSection: prompt }),
});

registerAdapter("langgraph", {
  requires: [{ kind: "peerPackage", name: "@langchain/langgraph" }],
  supports: [],
  pending: "needs a LangChain chat-model package as a devDependency",
  build: unbuildable("langgraph", "no LangChain chat-model package is installed"),
});

registerAdapter("letta", {
  requires: [{ kind: "peerPackage", name: "@letta-ai/letta-client" }, { kind: "envVar", name: "LETTA_BASE_URL" }],
  supports: [],
  pending: "needs a Letta server provisioned in CI",
  build: ({ prompt }) =>
    new LettaAdapter({
      lettaBaseUrl: process.env.LETTA_BASE_URL,
      lettaApiKey: process.env.LETTA_API_KEY,
      customSection: prompt,
    }),
});

registerAdapter("omp-acp", {
  requires: [ACP_SDK, { kind: "cli", command: DEFAULT_OMP_ACP_COMMAND[0] }, GEMINI_KEY],
  supports: [],
  build: ({ prompt, workDir }) =>
    new OmpACPAdapter({
      command: [...DEFAULT_OMP_ACP_COMMAND, "--model", `google/${GEMINI_MODEL}`],
      cwd: workDir,
      customSection: prompt,
    }),
});

registerAdapter("openai", {
  requires: [{ kind: "envVar", name: "OPENAI_API_KEY" }, { kind: "peerPackage", name: "openai" }],
  supports: [],
  pending: "needs an OPENAI_API_KEY provisioned in CI",
  build: ({ prompt }) => new OpenAIAdapter({ openAIModel: OPENAI_MODEL, systemPrompt: prompt }),
});

registerAdapter("opencode", {
  requires: [ANTHROPIC_KEY, { kind: "peerPackage", name: "@opencode-ai/sdk" }, { kind: "cli", command: "opencode" }],
  supports: ["approvals"],
  build: ({ prompt, workDir }) => {
    // Project config: OpenCode reaches Anthropic with our own key (BYOK) and asks before any bash.
    writeFileSync(
      join(workDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: { anthropic: { options: { apiKey: "{env:ANTHROPIC_API_KEY}" } } },
        permission: { bash: { "*": "ask" } },
      }),
    );
    return new OpencodeAdapter({
      config: { directory: workDir, providerId: "anthropic", modelId: ANTHROPIC_MODEL, customSection: prompt },
    });
  },
});

registerAdapter("parlant", {
  requires: [
    { kind: "peerPackage", name: "parlant-client" },
    { kind: "envVar", name: "PARLANT_ENVIRONMENT" },
    { kind: "envVar", name: "PARLANT_AGENT_ID" },
  ],
  supports: [],
  pending: "needs a Parlant server provisioned in CI",
  build: ({ prompt }) =>
    new ParlantAdapter({
      environment: process.env.PARLANT_ENVIRONMENT ?? "",
      agentId: process.env.PARLANT_AGENT_ID ?? "",
      apiKey: process.env.PARLANT_API_KEY,
      customSection: prompt,
    }),
});

registerAdapter("vercel-ai-sdk", {
  requires: [{ kind: "peerPackage", name: "ai" }],
  supports: [],
  pending: "needs an AI SDK model-provider package as a devDependency",
  build: unbuildable("vercel-ai-sdk", "no AI SDK model-provider package is installed"),
});
