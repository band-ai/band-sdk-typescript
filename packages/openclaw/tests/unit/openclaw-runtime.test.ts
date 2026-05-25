import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawRuntimeDispatch } from "../../src/openclaw-runtime.js";

describe("resolveOpenClawRuntimeDispatch", () => {
  it("rejects a missing runtime", () => {
    const result = resolveOpenClawRuntimeDispatch(undefined);

    expect(result.dispatch).toBeNull();
    expect(result.reason).toContain("runtime is not an object");
  });

  it("rejects a runtime without config.loadConfig", () => {
    const result = resolveOpenClawRuntimeDispatch({ channel: { reply: { dispatchReplyFromConfig: vi.fn() } } });

    expect(result.dispatch).toBeNull();
    expect(result.reason).toContain("runtime.config.loadConfig");
  });

  it("rejects a runtime without channel.reply.dispatchReplyFromConfig", () => {
    const result = resolveOpenClawRuntimeDispatch({ config: { loadConfig: vi.fn() }, channel: { reply: {} } });

    expect(result.dispatch).toBeNull();
    expect(result.reason).toContain("runtime.channel.reply.dispatchReplyFromConfig");
  });

  it("wraps a valid runtime dispatch shape", async () => {
    const cfg = { channels: {} };
    const loadConfig = vi.fn(() => cfg);
    const dispatchReplyFromConfig = vi.fn(async () => undefined);
    const result = resolveOpenClawRuntimeDispatch({
      config: { loadConfig },
      channel: { reply: { dispatchReplyFromConfig } },
    });

    expect(result.reason).toBeUndefined();
    expect(result.dispatch?.loadConfig()).toBe(cfg);

    const args = { ctx: {}, cfg, dispatcher: {} };
    await result.dispatch?.dispatchReplyFromConfig(args);

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfig).toHaveBeenCalledWith(args);
  });

  it("preserves OpenClaw runtime method receivers", async () => {
    const runtime = {
      config: {
        cfg: { channels: {} },
        loadConfig() {
          return this.cfg;
        },
      },
      channel: {
        reply: {
          calls: [] as unknown[],
          async dispatchReplyFromConfig(args: unknown) {
            this.calls.push(args);
          },
        },
      },
    };

    const result = resolveOpenClawRuntimeDispatch(runtime);
    const cfg = result.dispatch?.loadConfig();
    const args = { ctx: {}, cfg, dispatcher: {} };
    await result.dispatch?.dispatchReplyFromConfig(args);

    expect(cfg).toBe(runtime.config.cfg);
    expect(runtime.channel.reply.calls).toEqual([args]);
  });
});
