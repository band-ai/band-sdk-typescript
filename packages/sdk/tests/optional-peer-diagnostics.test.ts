import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryProvider } from "../src/runtime/types";

import { UnsupportedFeatureError } from "../src/core/errors";
import { loadOptionalPeer } from "../src/adapters/shared/optionalPeer";
import { FakeTools, makeMessage } from "./testUtils";

const mockedPeers: string[] = [];

afterEach(() => {
  for (const specifier of mockedPeers.splice(0)) {
    vi.doUnmock(specifier);
  }
  vi.resetModules();
});

/** Fails the dynamic import of `specifier` for modules loaded after this call. */
function breakPeer(specifier: string): void {
  vi.resetModules();
  mockedPeers.push(specifier);
  vi.doMock(specifier, () => {
    throw new Error(`Cannot find module '${specifier}'`);
  });
}

describe("loadOptionalPeer", () => {
  it("reports a missing package with an install hint and keeps the import error as cause", async () => {
    const failure = new Error("Cannot find module 'not-installed'");

    const caught = await loadOptionalPeer({
      feature: "TestAdapter",
      packageName: "not-installed",
      importModule: (): Promise<{ thing?: string }> => Promise.reject(failure),
      expectedExports: "`thing`",
      select: (module) => module.thing,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(UnsupportedFeatureError);
    const error = caught as UnsupportedFeatureError;
    expect(error.message).toContain('"not-installed"');
    expect(error.message).toContain('pnpm add not-installed');
    expect(error.cause).toBe(failure);
  });

  it("names the missing exports and omits the install hint when the package is present", async () => {
    const caught = await loadOptionalPeer({
      feature: "TestAdapter",
      packageName: "installed",
      importModule: () => Promise.resolve<{ thing?: string; somethingElse: number }>({ somethingElse: 1 }),
      expectedExports: "`thing`",
      select: (module) => module.thing,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(UnsupportedFeatureError);
    const error = caught as UnsupportedFeatureError;
    expect(error.message).toContain("does not export `thing`");
    expect(error.message).not.toContain("pnpm add");
  });

  it("applies the optional condition clause to the diagnostic", async () => {
    const caught = await loadOptionalPeer({
      feature: "TestAdapter",
      packageName: "conditional",
      condition: "when MCP tools are enabled",
      importModule: (): Promise<{ thing?: string }> => Promise.reject(new Error("boom")),
      expectedExports: "`thing`",
      select: (module) => module.thing,
    }).catch((error: unknown) => error);

    expect((caught as Error).message).toContain(
      'requires optional dependency "conditional" when MCP tools are enabled.',
    );
  });
});

/**
 * Every adapter that loads an optional peer must still name its own package and tell the
 * developer how to install it. Centralising the eight loaders behind one helper is only
 * safe if none of these diagnostics got weaker in the process.
 */
describe("missing optional peers stay diagnosable per adapter", () => {
  async function expectInstallHint(
    load: () => Promise<unknown>,
    packageName: string,
  ): Promise<void> {
    const caught = await load().catch((error: unknown) => error);

    // `vi.resetModules()` gives the adapter under test a fresh copy of the error module,
    // so compare against that copy's class rather than the one this file imported first.
    const errors = await import("../src/core/errors");
    expect(caught, `expected a throw for ${packageName}`).toBeInstanceOf(
      errors.UnsupportedFeatureError,
    );
    expect(caught).toBeInstanceOf(errors.BandSdkError);
    const error = caught as Error;
    expect(error.message).toContain(packageName);
    expect(error.message).toContain(`pnpm add ${packageName}`);
  }

  it("AnthropicToolCallingModel names @anthropic-ai/sdk", async () => {
    breakPeer("@anthropic-ai/sdk");
    const { AnthropicToolCallingModel } = await import("../src/adapters/anthropic/model");
    const model = new AnthropicToolCallingModel({ model: "claude" });

    await expectInstallHint(
      () => model.complete({ systemPrompt: "", messages: [], tools: [] }),
      "@anthropic-ai/sdk",
    );
  });

  it("OpenAIToolCallingModel names openai", async () => {
    breakPeer("openai");
    const { OpenAIToolCallingModel } = await import("../src/adapters/openai/model");
    const model = new OpenAIToolCallingModel({ model: "gpt" });

    await expectInstallHint(
      () => model.complete({ systemPrompt: "", messages: [], tools: [] }),
      "openai",
    );
  });

  it("GeminiToolCallingModel names @google/genai", async () => {
    breakPeer("@google/genai");
    const { GeminiToolCallingModel } = await import("../src/adapters/gemini/model");
    const model = new GeminiToolCallingModel({ model: "gemini" });

    await expectInstallHint(
      () => model.complete({ systemPrompt: "", messages: [], tools: [] }),
      "@google/genai",
    );
  });

  it("VercelAISDKToolCallingModel names ai", async () => {
    breakPeer("ai");
    const { VercelAISDKToolCallingModel } = await import("../src/adapters/vercel-ai-sdk/model");
    const model = new VercelAISDKToolCallingModel({ model: {} });

    await expectInstallHint(
      () => model.complete({ systemPrompt: "", messages: [], tools: [] }),
      "ai",
    );
  });

  it("LettaAdapter names @letta-ai/letta-client", async () => {
    breakPeer("@letta-ai/letta-client");
    const { LettaAdapter } = await import("../src/adapters/letta/LettaAdapter");
    const adapter = new LettaAdapter({ model: "letta/model" });

    await expectInstallHint(
      () =>
        adapter.onMessage(makeMessage("hi"), new FakeTools(), [], null, null, {
          isSessionBootstrap: true,
          roomId: "room-1",
        }),
      "@letta-ai/letta-client",
    );
  });

  it("ParlantAdapter names parlant-client", async () => {
    breakPeer("parlant-client");
    const { ParlantAdapter } = await import("../src/adapters/parlant/ParlantAdapter");
    const adapter = new ParlantAdapter({ agentId: "agent-1", environment: "test" });

    await expectInstallHint(
      () =>
        adapter.onMessage(makeMessage("hi"), new FakeTools(), [], null, null, {
          isSessionBootstrap: true,
          roomId: "room-1",
        }),
      "parlant-client",
    );
  });

  it("ClaudeSDKAdapter names @anthropic-ai/claude-agent-sdk", async () => {
    breakPeer("@anthropic-ai/claude-agent-sdk");
    const { ClaudeSDKAdapter } = await import("../src/adapters/claude-sdk/ClaudeSDKAdapter");
    const adapter = new ClaudeSDKAdapter({ model: "claude", enableMemoryTools: false });

    await expectInstallHint(
      () =>
        adapter.onMessage(makeMessage("hi"), new FakeTools(), new HistoryProvider([]), null, null, {
          isSessionBootstrap: true,
          roomId: "room-1",
        }),
      "@anthropic-ai/claude-agent-sdk",
    );
  });

  it("GoogleADKAdapter names @google/adk", async () => {
    breakPeer("@google/adk");
    const { GoogleADKAdapter } = await import("../src/adapters/google-adk/GoogleADKAdapter");
    const adapter = new GoogleADKAdapter({ model: "gemini" });

    await expectInstallHint(
      () =>
        adapter.onMessage(makeMessage("hi"), new FakeTools(), [], null, null, {
          isSessionBootstrap: true,
          roomId: "room-1",
        }),
      "@google/adk",
    );
  });
});
