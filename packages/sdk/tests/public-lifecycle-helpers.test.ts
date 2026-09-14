import { describe, expect, it, beforeAll } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, makeMessage } from "./testUtils";

const SDK_ROOT = resolve(__dirname, "..");
const distIndex = resolve(SDK_ROOT, "dist/index.js");
const distCore = resolve(SDK_ROOT, "dist/core.js");

describe("public lifecycle helpers (built package)", () => {
  beforeAll(() => {
    if (!existsSync(distIndex) || !existsSync(distCore)) {
      throw new Error("dist/ is required: run `pnpm --filter @band-ai/sdk build` first");
    }
  });

  it("exports the recoverable-turn helpers from the root and ./core entrypoints", async () => {
    const root = (await import(pathToFileURL(distIndex).href)) as Record<string, unknown>;
    const core = (await import(pathToFileURL(distCore).href)) as Record<string, unknown>;
    for (const name of [
      "deliverReply",
      "DeliveryFailedError",
      "RecoverableTurnError",
      "reportTurnFailure",
      "ProviderTurnFailedError",
      "agentFailure",
    ]) {
      expect(root[name], `root missing ${name}`).toBeTypeOf("function");
      expect(core[name], `core missing ${name}`).toBeTypeOf("function");
    }
  });

  it("lets a custom SimpleAdapter classify a rejected sendMessage as recoverable delivery failure", async () => {
    const core = await import(pathToFileURL(distCore).href) as {
      SimpleAdapter: new () => unknown;
      deliverReply: (tools: unknown, content: string) => Promise<unknown>;
      DeliveryFailedError: new (...args: unknown[]) => Error;
      agentFailure: (provider: string, message: string) => unknown;
      reportTurnFailure: (tools: unknown, failure: unknown) => Promise<never>;
    };

    class CustomAdapter extends (core.SimpleAdapter as new () => object) {
      protected readonly provider = "custom-proof";

      public async onMessage(
        message: { content: string },
        tools: unknown,
      ): Promise<void> {
        try {
          await core.deliverReply(tools, `echo: ${message.content}`);
        } catch (error) {
          if (error instanceof core.DeliveryFailedError) {
            throw error;
          }
          await core.reportTurnFailure(
            tools,
            core.agentFailure(this.provider, error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }

    const adapter = new CustomAdapter() as unknown as {
      onStarted: (a: string, b: string) => Promise<void>;
      onMessage: (...args: unknown[]) => Promise<void>;
    };
    await adapter.onStarted("Custom", "Proof adapter");
    const tools = new FakeTools({ failOn: ["sendMessage"] });
    await expect(
      adapter.onMessage(
        makeMessage("hello", "room-custom"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-custom" },
      ),
    ).rejects.toBeInstanceOf(core.DeliveryFailedError);
    expect(tools.messages).toEqual([]);
    expect(tools.events).toEqual([]);
  });

  it("exposes the five helpers from CJS root and core entries", () => {
    const require = createRequire(import.meta.url);
    const root = require(resolve(SDK_ROOT, "dist/index.cjs")) as Record<string, unknown>;
    const core = require(resolve(SDK_ROOT, "dist/core.cjs")) as Record<string, unknown>;
    for (const name of [
      "deliverReply",
      "DeliveryFailedError",
      "RecoverableTurnError",
      "reportTurnFailure",
      "ProviderTurnFailedError",
      "agentFailure",
    ]) {
      expect(typeof root[name], `cjs root missing ${name}`).toBe("function");
      expect(typeof core[name], `cjs core missing ${name}`).toBe("function");
    }
  });

  it("classifies a rejected sendMessage as delivery failure when CJS helpers share one entry", async () => {
    const require = createRequire(import.meta.url);
    const core = require(resolve(SDK_ROOT, "dist/core.cjs")) as {
      SimpleAdapter: new () => unknown;
      deliverReply: (tools: unknown, content: string) => Promise<unknown>;
      DeliveryFailedError: new (...args: unknown[]) => Error;
      agentFailure: (provider: string, message: string) => unknown;
      reportTurnFailure: (tools: unknown, failure: unknown) => Promise<never>;
    };

    class CustomAdapter extends (core.SimpleAdapter as new () => object) {
      protected readonly provider = "custom-cjs-proof";

      public async onMessage(
        message: { content: string },
        tools: unknown,
      ): Promise<void> {
        try {
          await core.deliverReply(tools, `echo: ${message.content}`);
        } catch (error) {
          if (error instanceof core.DeliveryFailedError) {
            throw error;
          }
          await core.reportTurnFailure(
            tools,
            core.agentFailure(this.provider, error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }

    const adapter = new CustomAdapter() as unknown as {
      onStarted: (a: string, b: string) => Promise<void>;
      onMessage: (...args: unknown[]) => Promise<void>;
    };
    await adapter.onStarted("Custom", "CJS proof adapter");
    const tools = new FakeTools({ failOn: ["sendMessage"] });
    await expect(
      adapter.onMessage(
        makeMessage("hello", "room-custom-cjs"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-custom-cjs" },
      ),
    ).rejects.toBeInstanceOf(core.DeliveryFailedError);
    expect(tools.messages).toEqual([]);
    expect(tools.events).toEqual([]);
  });
});
