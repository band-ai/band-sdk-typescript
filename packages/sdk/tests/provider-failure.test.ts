import { describe, expect, it, vi } from "vitest";
import { AgentFailure } from "@band-ai/band-sdk-core";

import {
  ProviderTurnFailedError,
  agentFailure,
  reportTurnFailure,
  safeSendFailure,
} from "../src/core/providerFailure";
import { DeliveryFailedError } from "../src/core/deliveryFailedError";
import { rethrowIfRecoverableTurnFailure } from "../src/core/errors";
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

describe("safeSendFailure", () => {
  it("resolves instead of throwing/rejecting when tools.sendFailure rejects, and logs the failure", async () => {
    const failure = new AgentFailure("test", "boom", "some_code");
    const sendFailureError = new Error("sendFailure transport error");
    const tools = {
      sendFailure: async () => {
        throw sendFailureError;
      },
    } as unknown as MessagingTools;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(safeSendFailure(tools, failure, logger, { roomId: "room-1" })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith("provider_failure.report_failed", {
      provider: "test",
      code: "some_code",
      roomId: "room-1",
      error: sendFailureError,
    });
  });

  it("still logs the failure via the given logger even when tools.sendFailure succeeds", async () => {
    const failure = new AgentFailure("test", "boom", "some_code");
    const tools = { sendFailure: vi.fn(async () => ({ ok: true })) } as unknown as MessagingTools;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(safeSendFailure(tools, failure, logger, { roomId: "room-1" })).resolves.toBeUndefined();

    expect(tools.sendFailure).toHaveBeenCalledWith(failure);
    // The room event this posts isn't the only place a provider failure
    // should be visible -- an operator's Logger/observability sink needs its
    // own record too, independent of whether the room delivery itself
    // succeeds.
    expect(logger.warn).toHaveBeenCalledWith("provider_failure.reported", {
      provider: "test",
      code: "some_code",
      roomId: "room-1",
    });
  });
});

describe("agentFailure", () => {
  it("passes a JSON-serializable detail through unchanged", () => {
    const failure = agentFailure("test", "boom", "code", { httpStatus: 500 });

    expect(failure.detail).toEqual({ httpStatus: 500 });
  });

  it("falls back to a detail-less AgentFailure, instead of throwing, when detail cannot be serialized", () => {
    // AgentFailure's WASM-backed constructor genuinely rejects a
    // function-valued property with a raw Error -- verified directly against
    // the real @band-ai/band-sdk-core constructor, not assumed from its name.
    const unserializableDetail = { handler: () => undefined };

    const failure = agentFailure("test", "boom", "code", unserializableDetail);

    expect(failure).toBeInstanceOf(AgentFailure);
    expect(failure.provider).toBe("test");
    expect(failure.message).toBe("boom");
    expect(failure.code).toBe("code");
    expect(failure.detail).toBeUndefined();
  });

  it("does not attempt to construct with a detail argument at all when detail is undefined", () => {
    const failure = agentFailure("test", "boom");

    expect(failure.detail).toBeUndefined();
  });
});

describe("rethrowIfRecoverableTurnFailure", () => {
  it("rethrows a ProviderTurnFailedError", () => {
    const error = new ProviderTurnFailedError(new AgentFailure("test", "boom"));
    expect(() => rethrowIfRecoverableTurnFailure(error)).toThrow(error);
  });

  it("rethrows a DeliveryFailedError", () => {
    const error = new DeliveryFailedError(new Error("post failed"));
    expect(() => rethrowIfRecoverableTurnFailure(error)).toThrow(error);
  });

  it("does nothing for any other error", () => {
    expect(() => rethrowIfRecoverableTurnFailure(new Error("unrelated"))).not.toThrow();
  });
});
