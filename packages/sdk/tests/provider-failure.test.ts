import { describe, expect, it } from "vitest";
import { AgentFailure } from "@band-ai/band-sdk-core";

import {
  ProviderTurnFailedError,
  reportTurnFailure,
  rethrowIfProviderTurnFailure,
} from "../src/adapters/shared/providerFailure";
import type { MessagingTools } from "../src/contracts/protocols";

describe("reportTurnFailure", () => {
  it("still throws ProviderTurnFailedError, not a raw rejection, when sendFailure itself rejects", async () => {
    const failure = new AgentFailure("test", "boom");
    const tools = {
      sendFailure: async () => {
        throw new Error("sendFailure transport error");
      },
    } as unknown as MessagingTools;

    await expect(reportTurnFailure(tools, failure)).rejects.toBeInstanceOf(ProviderTurnFailedError);
  });
});

describe("rethrowIfProviderTurnFailure", () => {
  it("rethrows a ProviderTurnFailedError", () => {
    const error = new ProviderTurnFailedError(new AgentFailure("test", "boom"));
    expect(() => rethrowIfProviderTurnFailure(error)).toThrow(error);
  });

  it("does nothing for any other error", () => {
    expect(() => rethrowIfProviderTurnFailure(new Error("unrelated"))).not.toThrow();
  });
});
