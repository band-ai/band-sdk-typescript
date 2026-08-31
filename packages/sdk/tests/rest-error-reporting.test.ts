import { describe, expect, it } from "vitest";

import { RestFacade } from "../src/client/rest/RestFacade";
import { ValidationError } from "../src/core/errors";
import type { Logger } from "../src/core/logger";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { fetchPaginated, normalizePaginationMetadata } from "../src/client/rest/pagination";
import { FakeRestApi } from "./testUtils";

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

function capturingLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const record = (level: CapturedLog["level"]) =>
    (message: string, context?: Record<string, unknown>): void => {
      entries.push({ level, message, context });
    };

  return {
    entries,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}

describe("RestFacade reports failures without replacing them", () => {
  it("warns with the operation, its metadata, and the error, then rethrows the same instance", async () => {
    const failure = new Error("upstream exploded");
    const { logger, entries } = capturingLogger();
    const facade = new RestFacade({
      logger,
      api: new FakeRestApi({
        createChatMessage: () => {
          throw failure;
        },
      }),
    });

    await expect(
      facade.createChatMessage("room-1", { content: "hi" }),
    ).rejects.toBe(failure);

    const warning = entries.find((entry) => entry.level === "warn");
    expect(warning?.message).toBe("REST createChatMessage failed");
    expect(warning?.context).toMatchObject({
      operation: "createChatMessage",
      chatId: "room-1",
      error: failure,
    });
  });

  it("warns for optional operations too, which reach the transport by a different route", async () => {
    const failure = new Error("chat listing unavailable");
    const { logger, entries } = capturingLogger();
    const facade = new RestFacade({
      logger,
      api: new FakeRestApi({
        listChats: () => {
          throw failure;
        },
      }),
    });

    await expect(facade.listChats({ page: 1, pageSize: 10 })).rejects.toBe(failure);
    expect(entries.filter((entry) => entry.level === "warn")).toHaveLength(1);
  });

  it("leaves successful calls unwarned", async () => {
    const { logger, entries } = capturingLogger();
    const facade = new RestFacade({ logger, api: new FakeRestApi() });

    await expect(facade.getAgentMe()).resolves.toMatchObject({ id: "agent-1" });
    expect(entries.filter((entry) => entry.level === "warn")).toEqual([]);
  });
});

describe("malformed REST responses raise ValidationError", () => {
  it("rejects pagination metadata that is not an integer", () => {
    expect(() => normalizePaginationMetadata({ page: "not-a-number" })).toThrow(ValidationError);
  });

  it("rejects a paginated page whose data is not an array", async () => {
    await expect(
      fetchPaginated({
        fetchPage: async () => ({ data: undefined as never }),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an identity envelope that is not an object", async () => {
    const adapter = new FernRestAdapter({
      agentApiIdentity: {
        getAgentMe: async () => ({ data: "nope" }),
      },
    });

    await expect(adapter.getAgentMe()).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an identity payload with a non-string name", async () => {
    const adapter = new FernRestAdapter({
      agentApiIdentity: {
        getAgentMe: async () => ({ data: { id: "a1", name: 42 } }),
      },
    });

    await expect(adapter.getAgentMe()).rejects.toBeInstanceOf(ValidationError);
  });
});
