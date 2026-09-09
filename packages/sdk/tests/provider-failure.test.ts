import { describe, expect, it, vi } from "vitest";
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

  it("still throws ProviderTurnFailedError, not a raw error, when a custom sendFailure throws synchronously instead of returning a rejecting promise", async () => {
    const failure = new AgentFailure("test", "boom");
    const tools = {
      // A non-`async` implementation can throw before ever returning a
      // promise -- `.catch()` on the call expression would never see this.
      sendFailure: () => {
        throw new Error("sendFailure threw before returning a promise");
      },
    } as unknown as MessagingTools;

    await expect(reportTurnFailure(tools, failure)).rejects.toBeInstanceOf(ProviderTurnFailedError);
  });

  it("logs the swallowed sendFailure error via the given logger, so a lost terminal-failure report leaves a trace", async () => {
    const failure = new AgentFailure("test", "boom", "some_code");
    const sendFailureError = new Error("sendFailure transport error");
    const tools = {
      sendFailure: async () => {
        throw sendFailureError;
      },
    } as unknown as MessagingTools;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(reportTurnFailure(tools, failure, logger, { roomId: "room-1" })).rejects.toBeInstanceOf(
      ProviderTurnFailedError,
    );

    expect(logger.warn).toHaveBeenCalledWith("provider_failure.report_failed", {
      provider: "test",
      code: "some_code",
      roomId: "room-1",
      error: sendFailureError,
    });
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
