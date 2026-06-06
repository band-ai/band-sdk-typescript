export interface OpenClawRuntimeDispatchArgs {
  ctx: Record<string, unknown>;
  cfg: unknown;
  dispatcher: Record<string, unknown>;
}

export interface OpenClawRuntimeDispatch {
  loadConfig: () => unknown;
  dispatchReplyFromConfig: (args: OpenClawRuntimeDispatchArgs) => Promise<void>;
}

export interface OpenClawRuntimeDispatchResolution {
  dispatch: OpenClawRuntimeDispatch | null;
  reason?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object";
}

export function resolveOpenClawRuntimeDispatch(runtime: unknown): OpenClawRuntimeDispatchResolution {
  if (!isRecord(runtime)) {
    return { dispatch: null, reason: "runtime is not an object" };
  }

  const config = runtime.config;
  if (!isRecord(config) || typeof config.loadConfig !== "function") {
    return { dispatch: null, reason: "runtime.config.loadConfig is not available" };
  }

  const channel = runtime.channel;
  if (!isRecord(channel)) {
    return { dispatch: null, reason: "runtime.channel is not available" };
  }

  const reply = channel.reply;
  if (!isRecord(reply) || typeof reply.dispatchReplyFromConfig !== "function") {
    return { dispatch: null, reason: "runtime.channel.reply.dispatchReplyFromConfig is not available" };
  }

  const loadConfig = (config.loadConfig as () => unknown).bind(config);
  const dispatchReplyFromConfig = (reply.dispatchReplyFromConfig as (args: OpenClawRuntimeDispatchArgs) => Promise<void>).bind(reply);

  return {
    dispatch: {
      loadConfig,
      dispatchReplyFromConfig,
    },
  };
}
