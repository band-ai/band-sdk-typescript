/**
 * Codex (OpenAI Codex CLI) adapter.
 *
 * Wraps the `@openai/codex-sdk` runtime — an agentic loop that can run
 * shell commands, edit files, and reason iteratively with reasoning effort
 * settings. Counterpart to `claude-sdk/`: same shape (full coding agent
 * over Thenvoi), different model + tool stack.
 */
import {
  Agent,
  CodexAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import {
  CodexAppServerStdioClient,
  type CodexAdapterConfig,
  type CodexClientLike,
} from "@thenvoi/sdk/adapters";

interface CodexExampleOptions {
  /** Override the default model. */
  model?: string;
  /** Working directory for shell + file ops. Defaults to the process cwd. */
  cwd?: string;
  /** When Codex asks to run a command, what to do — `never` runs without prompting. */
  approvalPolicy?: CodexAdapterConfig["approvalPolicy"];
  /** Sandboxing for shell commands; `workspace-write` allows edits in cwd only. */
  sandboxMode?: CodexAdapterConfig["sandboxMode"];
  /** `low` / `medium` / `high` / `xhigh`. Higher costs more, thinks more. */
  reasoningEffort?: CodexAdapterConfig["reasoningEffort"];
}

type CodexRpcEvent = Awaited<ReturnType<CodexClientLike["recvEvent"]>>;

class TerminalCodexClient implements CodexClientLike {
  private assistantLineOpen = false;

  public constructor(private readonly inner: CodexClientLike) {}

  public async connect(): Promise<void> {
    terminalLine("starting Codex app-server");
    await this.inner.connect();
    terminalLine("Codex app-server connected");
  }

  public async initialize(...args: Parameters<CodexClientLike["initialize"]>): ReturnType<CodexClientLike["initialize"]> {
    await this.inner.initialize(...args);
    terminalLine("Codex app-server initialized");
  }

  public async request<TResult>(method: string, params?: Record<string, unknown>): Promise<TResult> {
    if (method === "turn/start") {
      terminalLine("turn started");
    }
    return await this.inner.request<TResult>(method, params);
  }

  public async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.inner.notify(method, params);
  }

  public async respond(...args: Parameters<CodexClientLike["respond"]>): ReturnType<CodexClientLike["respond"]> {
    terminalLine("tool response sent to Codex");
    return await this.inner.respond(...args);
  }

  public async respondError(...args: Parameters<CodexClientLike["respondError"]>): ReturnType<CodexClientLike["respondError"]> {
    terminalLine("tool error sent to Codex");
    return await this.inner.respondError(...args);
  }

  public async recvEvent(timeoutMs?: number): Promise<CodexRpcEvent> {
    const event = await this.inner.recvEvent(timeoutMs);
    this.logEvent(event);
    return event;
  }

  public async close(): Promise<void> {
    this.closeAssistantLine();
    terminalLine("Codex app-server stopped");
    await this.inner.close();
  }

  private logEvent(event: CodexRpcEvent): void {
    const params = asRecord(event.params);

    if (event.kind === "request" && event.method === "item/tool/call") {
      this.closeAssistantLine();
      terminalLine(`tool_call ${String(params.tool ?? "unknown")}`);
      terminalJson(params.arguments);
      return;
    }

    if (event.kind !== "notification") {
      return;
    }

    if (event.method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!delta) {
        return;
      }
      if (!this.assistantLineOpen) {
        process.stdout.write("[codex:assistant] ");
        this.assistantLineOpen = true;
      }
      process.stdout.write(delta);
      return;
    }

    if (event.method === "item/completed") {
      this.logCompletedItem(asRecord(params.item));
      return;
    }

    if (event.method === "turn/completed") {
      this.closeAssistantLine();
      const turn = asRecord(params.turn);
      terminalLine(`turn ${String(turn.status ?? "completed")}`);
      return;
    }

    if (event.method === "error") {
      this.closeAssistantLine();
      terminalLine("error");
      terminalJson(params.error ?? params);
    }
  }

  private logCompletedItem(item: Record<string, unknown>): void {
    const type = String(item.type ?? "unknown");

    if (type === "agentMessage") {
      this.closeAssistantLine();
      if (typeof item.text === "string" && item.text.trim()) {
        terminalLine(`assistant ${item.text}`);
      }
      return;
    }

    this.closeAssistantLine();

    if (type === "reasoning") {
      const text = [...asStringArray(item.summary), ...asStringArray(item.content)].join("\n").trim();
      if (text) {
        terminalLine(`thinking ${text}`);
      }
      return;
    }

    if (type === "plan") {
      terminalLine(`plan ${String(item.text ?? "")}`.trim());
      return;
    }

    if (type === "commandExecution") {
      terminalLine(`exec ${String(item.command ?? "")}`.trim());
      if (item.aggregatedOutput) {
        terminalJson({ output: item.aggregatedOutput, exitCode: item.exitCode, status: item.status });
      }
      return;
    }

    if (type === "fileChange") {
      terminalLine("file_change");
      terminalJson({ changes: item.changes, status: item.status });
      return;
    }

    if (type === "mcpToolCall") {
      terminalLine(`mcp ${String(item.server ?? "unknown")}/${String(item.tool ?? "unknown")}`);
      terminalJson({ arguments: item.arguments, result: item.result, error: item.error });
      return;
    }

    if (["webSearch", "imageView", "contextCompaction", "enteredReviewMode", "exitedReviewMode"].includes(type)) {
      terminalLine(type);
      terminalJson(item);
    }
  }

  private closeAssistantLine(): void {
    if (!this.assistantLineOpen) {
      return;
    }
    process.stdout.write("\n");
    this.assistantLineOpen = false;
  }
}

function terminalLine(message: string): void {
  process.stdout.write(`[codex] ${message}\n`);
}

function terminalJson(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function createCodexAgent(
  options: CodexExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const config: CodexAdapterConfig = {
    model: options.model,
    cwd: options.cwd,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandboxMode: options.sandboxMode ?? "workspace-write",
    reasoningEffort: options.reasoningEffort,
    // These two give you full visibility in the Band UI.
    enableExecutionReporting: true,
    emitThoughtEvents: true,
    enableLocalCommands: true,
  };
  const terminalLog = ["1", "true", "yes"].includes((process.env.CODEX_TERMINAL_LOG ?? "").toLowerCase());

  const adapter = new CodexAdapter({
    config,
    ...(terminalLog
      ? {
        factory: async () => new TerminalCodexClient(new CodexAppServerStdioClient({
          command: config.codexCommand,
          cwd: config.cwd,
          env: config.codexEnv,
        })),
      }
      : {}),
  });

  if (terminalLog) {
    terminalLine("terminal monitor enabled");
  }

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "codex-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("codex_agent");
  void createCodexAgent({}, config).run();
}
