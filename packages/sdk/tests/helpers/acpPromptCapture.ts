import { vi } from "vitest";

import type { ACPClientConnectionFactory } from "../../src/adapters/acp/types";

export interface AcpPromptCaptureHarness {
  promptTexts: string[];
  connectionFactory: ACPClientConnectionFactory;
}

/** Minimal ACP connection stub that records prompt text from the first user turn. */
export function createAcpPromptCaptureHarness(): AcpPromptCaptureHarness {
  const promptTexts: string[] = [];

  const initialize = vi.fn(async () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true },
    },
    authMethods: [{ id: "api_key", name: "API Key" }],
  }));
  const authenticate = vi.fn(async () => ({ success: true }));
  const newSession = vi.fn(async () => ({ sessionId: "session-new" }));
  const prompt = vi.fn(async (params: { prompt: Array<{ text?: string }> }) => {
    promptTexts.push(params.prompt[0]?.text ?? "");
    return { stopReason: "end_turn" as const };
  });

  const connectionFactory: ACPClientConnectionFactory = async () => {
    const controller = new AbortController();
    return {
      connection: {
        signal: controller.signal,
        closed: new Promise<void>(() => undefined),
        initialize,
        authenticate,
        newSession,
        loadSession: vi.fn(),
        resumeSession: vi.fn(),
        prompt,
      } as never,
      stop: async () => {
        controller.abort();
      },
    };
  };

  return { promptTexts, connectionFactory };
}
