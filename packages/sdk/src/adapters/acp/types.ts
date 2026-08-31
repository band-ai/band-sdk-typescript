import type {
  Client,
  ClientSideConnection,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface CollectedChunk {
  chunkType: "text" | "thought" | "tool_call" | "tool_result" | "plan";
  content: string;
  metadata: Record<string, unknown>;
}

export interface PendingACPPrompt {
  sessionId: string;
  done: Promise<void>;
  markDone(): void;
  terminalMessageSeen: boolean;
  completionTimer: ReturnType<typeof setTimeout> | null;
}

export interface ACPClientConnectionHandle {
  connection: ClientSideConnection;
  stop(): Promise<void>;
}

export type ACPClientConnectionFactory = (
  client: Client,
  options: {
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
  },
) => Promise<ACPClientConnectionHandle>;

export type ACPPermissionHandler = (
  params: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

export const DEFAULT_ACP_SERVER_MODES: Array<{
  id: string;
  name: string;
  description: string;
}> = [
  {
    id: "default",
    name: "Default",
    description: "General-purpose chat mode",
  },
  {
    id: "code",
    name: "Code",
    description: "Route prompts toward coding peers when available",
  },
]

export function createPendingPrompt(sessionId: string): PendingACPPrompt {
  let markDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    markDone = resolve
  })

  return {
    sessionId,
    done,
    markDone,
    terminalMessageSeen: false,
    completionTimer: null,
  }
}

export function choosePermissionOption(
  options: PermissionOption[],
): PermissionOption | null {
  return options.find((option) => option.kind === "allow_once")
    ?? options.find((option) => option.kind === "allow_always")
    ?? options[0]
    ?? null
}

export function asJsonSafe(value: unknown): unknown {
  if (
    value === null
    || value === undefined
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => asJsonSafe(item))
  }

  if (typeof value === "object") {
    if ("model_dump" in value && typeof value.model_dump === "function") {
      return asJsonSafe((value.model_dump as () => unknown)())
    }

    if ("toJSON" in value && typeof value.toJSON === "function") {
      return asJsonSafe((value.toJSON as () => unknown)())
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, asJsonSafe(item)]),
    )
  }

  return String(value)
}

export function normalizeMcpServers(
  mcpServers: readonly McpServer[] | undefined,
): Array<Record<string, unknown>> {
  if (!mcpServers) {
    return []
  }

  return mcpServers
    .map((server) => asJsonSafe(server))
    .filter((server): server is Record<string, unknown> => !!server && typeof server === "object" && !Array.isArray(server))
}
