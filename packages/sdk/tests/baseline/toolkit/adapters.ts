/**
 * The roster: one spec per framework adapter — what it needs and how to build
 * a helpful agent from a steering prompt. The adapter ids, their typed
 * handles, and the registry are all derived from `SPECS`, so adding an
 * adapter is adding its spec here; `registry.test.ts` fails until every
 * directory under `src/adapters/` has one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
  type ClaudeSDKAdapterOptions,
  type LettaAdapterOptions,
  type OmpACPAdapterOptions,
  type OpencodeAdapterConfig,
  type ParlantAdapterOptions,
} from "../../../src/adapters";
import { AdapterRegistry, CAPABILITY, requires, type AdapterSpec, type BuildOptions } from "./registry";

const ANTHROPIC_MODEL = "claude-haiku-4-5";
const GEMINI_MODEL = "gemini-2.5-flash";
const OPENAI_MODEL = "gpt-5.2";

const ENV = {
  anthropicKey: "ANTHROPIC_API_KEY",
  googleKey: "GOOGLE_API_KEY",
  geminiKey: "GEMINI_API_KEY",
  cursorKey: "CURSOR_API_KEY",
  kiroKey: "KIRO_API_KEY",
  openaiKey: "OPENAI_API_KEY",
  lettaUrl: "LETTA_BASE_URL",
  lettaKey: "LETTA_API_KEY",
  parlantEnvironment: "PARLANT_ENVIRONMENT",
  parlantKey: "PARLANT_API_KEY",
} as const;

const ANTHROPIC_KEY = requires.envVar(ENV.anthropicKey);
const ACP_SDK = requires.peerPackage("@agentclientprotocol/sdk");

// Either variable, as in band-sdk-python; when both are set, GOOGLE_API_KEY wins, as it does in Google's SDKs.
const GOOGLE_KEY_VARS = [ENV.googleKey, ENV.geminiKey] as const;
const GOOGLE_KEY = requires.anyEnvVar(...GOOGLE_KEY_VARS);

/** The Gemini API key every Google-model adapter is given, so none picks a different one of the two. */
function googleApiKey(): string | undefined {
  return GOOGLE_KEY_VARS.map((name) => process.env[name]).find(Boolean);
}

/** Claude Code on the pinned Anthropic model in the cell's working directory, `options` layered over the defaults. */
export function buildClaudeSdk({ prompt, workDir }: BuildOptions, options: ClaudeSDKAdapterOptions = {}): ClaudeSDKAdapter {
  return new ClaudeSDKAdapter({ model: ANTHROPIC_MODEL, customSection: prompt, cwd: workDir, ...options });
}

/** OMP on the pinned Google model. */
const OMP_COMMAND = [...DEFAULT_OMP_ACP_COMMAND, "--model", `google/${GEMINI_MODEL}`];

/** OMP on the pinned Google model with an isolated state directory, `options` layered over the defaults. */
export function buildOmp({ prompt, workDir }: BuildOptions, options: OmpACPAdapterOptions = {}): OmpACPAdapter {
  return new OmpACPAdapter({
    command: OMP_COMMAND,
    cwd: workDir,
    customSection: prompt,
    // OMP reads only GEMINI_API_KEY.
    env: { PI_CODING_AGENT_DIR: stateDir(workDir, ".omp-state"), [ENV.geminiKey]: googleApiKey() ?? "" },
    ...options,
  });
}

/** A fresh directory under the cell's working directory, for a CLI's own state. */
function stateDir(workDir: string, name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Letta on the pinned Anthropic model, `options` layered over the defaults. The server holds the model key. */
export function buildLetta({ prompt }: BuildOptions, options: LettaAdapterOptions = {}): LettaAdapter {
  return new LettaAdapter({
    lettaBaseUrl: process.env[ENV.lettaUrl],
    lettaApiKey: process.env[ENV.lettaKey],
    model: `anthropic/${ANTHROPIC_MODEL}`,
    customSection: prompt,
    ...options,
  });
}

/** Parlant on an agent it creates from the prompt, `options` layered over the defaults. */
export function buildParlant({ prompt }: BuildOptions, options: Partial<ParlantAdapterOptions> = {}): ParlantAdapter {
  return new ParlantAdapter({
    environment: process.env[ENV.parlantEnvironment] ?? "",
    apiKey: process.env[ENV.parlantKey],
    customSection: prompt,
    ...options,
  });
}

/** The OpenCode provider the baseline runs it on, with our own key (BYOK). */
const OPENCODE_PROVIDER = "anthropic";

/** OpenCode on Anthropic, `config` layered over the defaults. */
export function buildOpencode({ prompt, workDir }: BuildOptions, config: OpencodeAdapterConfig = {}): OpencodeAdapter {
  // Project config: OpenCode reaches Anthropic with our own key, and asks before any bash.
  writeFileSync(
    join(workDir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { [OPENCODE_PROVIDER]: { options: { apiKey: `{env:${ENV.anthropicKey}}` } } },
      permission: { bash: { "*": "ask" } },
    }),
  );
  return new OpencodeAdapter({
    config: { directory: workDir, providerId: OPENCODE_PROVIDER, modelId: ANTHROPIC_MODEL, customSection: prompt, ...config },
  });
}

/** Reports every custom-tool call as a `tool_call` event, so a scenario that gives tools can read them back. */
function reportsTools(tools: BuildOptions["customTools"]) {
  return { enableExecutionReporting: Boolean(tools?.length) };
}

/** A builder for an adapter that cannot run yet; it names why instead of half-building one. */
function unbuildable(reason: string): () => never {
  return () => {
    throw new Error(`this adapter cannot be built: ${reason}`);
  };
}

/** Keyed by handle; each spec's `id` is its directory under `src/adapters/`. */
const SPECS = {
  anthropic: {
    id: "anthropic",
    requires: [ANTHROPIC_KEY, requires.peerPackage("@anthropic-ai/sdk")],
    supports: [CAPABILITY.customTools],
    build: ({ prompt, customTools }) =>
      new AnthropicAdapter({ anthropicModel: ANTHROPIC_MODEL, systemPrompt: prompt, customTools, ...reportsTools(customTools) }),
  },
  claudeSdk: {
    id: "claude-sdk",
    requires: [ANTHROPIC_KEY, requires.peerPackage("@anthropic-ai/claude-agent-sdk")],
    supports: [],
    build: (options) => buildClaudeSdk(options),
  },
  codex: {
    id: "codex",
    requires: [requires.peerPackage("@openai/codex-sdk"), requires.cli("codex")],
    supports: [],
    pending: "needs Codex CLI authentication provisioned in CI",
    build: ({ prompt, workDir }) => new CodexAdapter({ config: { cwd: workDir, customSection: prompt, approvalPolicy: "never" } }),
  },
  copilotAcp: {
    id: "copilot-acp",
    requires: [
      ACP_SDK,
      requires.cli(DEFAULT_COPILOT_ACP_COMMAND[0]),
      // A hosted Copilot token, or the BYOK provider CI configures.
      requires.anyEnvVar("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_PROVIDER_BASE_URL"),
    ],
    supports: [],
    build: ({ prompt, workDir }) =>
      new CopilotACPAdapter({
        cwd: workDir,
        customSection: prompt,
        // An isolated Copilot home, and no interactive tool confirmations.
        env: { COPILOT_HOME: stateDir(workDir, ".copilot-home"), COPILOT_ALLOW_ALL: "true" },
      }),
  },
  cursorAcp: {
    id: "cursor-acp",
    requires: [ACP_SDK, requires.cli(DEFAULT_CURSOR_ACP_COMMAND[0]), requires.envVar(ENV.cursorKey)],
    supports: [],
    pending: "needs the Cursor agent CLI and a CURSOR_API_KEY provisioned in CI",
    build: ({ prompt, workDir }) =>
      new CursorACPAdapter({ cwd: workDir, customSection: prompt, apiKey: process.env[ENV.cursorKey] }),
  },
  gemini: {
    id: "gemini",
    requires: [GOOGLE_KEY, requires.peerPackage("@google/genai")],
    supports: [CAPABILITY.customTools],
    build: ({ prompt, customTools }) =>
      new GeminiAdapter({ geminiModel: GEMINI_MODEL, apiKey: googleApiKey(), systemPrompt: prompt, customTools, ...reportsTools(customTools) }),
  },
  googleAdk: {
    id: "google-adk",
    requires: [GOOGLE_KEY, requires.peerPackage("@google/adk")],
    supports: [CAPABILITY.customTools],
    build: ({ prompt, customTools }) =>
      new GoogleADKAdapter({
        model: GEMINI_MODEL,
        apiKey: googleApiKey(),
        systemPrompt: prompt,
        additionalTools: customTools,
        ...reportsTools(customTools),
      }),
  },
  kiroAcp: {
    id: "kiro-acp",
    requires: [ACP_SDK, requires.cli(DEFAULT_KIRO_ACP_COMMAND[0]), requires.envVar(ENV.kiroKey)],
    supports: [],
    pending: "needs the Kiro CLI and a KIRO_API_KEY provisioned in CI",
    build: ({ prompt, workDir }) => new KiroACPAdapter({ cwd: workDir, customSection: prompt }),
  },
  langgraph: {
    id: "langgraph",
    requires: [requires.peerPackage("@langchain/langgraph")],
    supports: [],
    pending: "needs a LangChain chat-model package as a devDependency",
    build: unbuildable("no LangChain chat-model package is installed"),
  },
  letta: {
    id: "letta",
    requires: [requires.peerPackage("@letta-ai/letta-client"), requires.envVar(ENV.lettaUrl)],
    supports: [],
    build: (options) => buildLetta(options),
  },
  ompAcp: {
    id: "omp-acp",
    requires: [ACP_SDK, requires.cli(DEFAULT_OMP_ACP_COMMAND[0]), GOOGLE_KEY],
    supports: [],
    build: (options) => buildOmp(options),
  },
  openai: {
    id: "openai",
    requires: [requires.envVar(ENV.openaiKey), requires.peerPackage("openai")],
    supports: [CAPABILITY.customTools],
    build: ({ prompt, customTools }) => new OpenAIAdapter({ openAIModel: OPENAI_MODEL, systemPrompt: prompt, customTools, ...reportsTools(customTools) }),
  },
  opencode: {
    id: "opencode",
    requires: [ANTHROPIC_KEY, requires.peerPackage("@opencode-ai/sdk"), requires.cli("opencode")],
    supports: [CAPABILITY.approvals],
    build: (options) => buildOpencode(options),
  },
  parlant: {
    id: "parlant",
    requires: [requires.peerPackage("parlant-client"), requires.envVar(ENV.parlantEnvironment)],
    supports: [],
    // As in band-sdk-python, whose Parlant agent does hold the Band tools, via a Parlant tool service.
    bespokeOnly: "has no Band platform tools, which the generic scenarios assume",
    build: (options) => buildParlant(options),
  },
  vercelAiSdk: {
    id: "vercel-ai-sdk",
    requires: [requires.peerPackage("ai")],
    supports: [],
    pending: "needs an AI SDK model-provider package as a devDependency",
    build: unbuildable("no AI SDK model-provider package is installed"),
  },
} as const satisfies Record<string, AdapterSpec>;

type Specs = typeof SPECS;

export type AdapterId = Specs[keyof Specs]["id"];

/** A roster adapter's spec. */
export type RosterSpec = AdapterSpec<AdapterId>;

/** Typed adapter ids for scenarios that name particular adapters, e.g. `ADAPTER.googleAdk`. */
export const ADAPTER = Object.fromEntries(Object.entries(SPECS).map(([handle, spec]) => [handle, spec.id])) as {
  readonly [Handle in keyof Specs]: Specs[Handle]["id"];
};

export const ADAPTER_IDS: readonly AdapterId[] = Object.values(ADAPTER);

export const registry = new AdapterRegistry<AdapterId>(Object.values(SPECS));

export function specs(filter?: Parameters<typeof registry.specs>[0]): RosterSpec[] {
  return registry.specs(filter);
}
