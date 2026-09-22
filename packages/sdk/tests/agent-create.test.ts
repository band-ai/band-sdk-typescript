import { describe, expect, it } from "vitest";

import { Agent } from "../src/agent/Agent";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { ValidationError } from "../src/core/errors";
import { MAX_MESSAGE_RETRIES } from "../src/runtime/types";

describe("Agent.create", () => {
  it("accepts a typed config object without spreading credentials", () => {
    const agent = Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      config: {
        agentId: "agent-from-config",
        apiKey: "key-from-config",
      },
    });

    expect(agent.runtime.agentId).toBe("agent-from-config");
  });

  it("lets explicit credentials override config values", () => {
    const agent = Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      config: {
        agentId: "agent-from-config",
        apiKey: "key-from-config",
      },
      agentId: "agent-override",
      apiKey: "key-override",
    });

    expect(agent.runtime.agentId).toBe("agent-override");
  });

  // RetryTracker rejects these, but only once a room's context is built
  // mid-run, which takes down the whole runtime.
  it.each([-1, 1.5, NaN, Infinity, MAX_MESSAGE_RETRIES + 1])("rejects maxMessageRetries=%s up front", (maxMessageRetries) => {
    expect(() =>
      Agent.create({
        adapter: new GenericAdapter(async () => undefined),
        agentId: "agent-1",
        apiKey: "key-1",
        sessionConfig: { maxMessageRetries },
      }),
    ).toThrow(ValidationError);
  });

  it("accepts maxMessageRetries=0", () => {
    const agent = Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      agentId: "agent-1",
      apiKey: "key-1",
      sessionConfig: { maxMessageRetries: 0 },
    });

    expect(agent.runtime.agentId).toBe("agent-1");
  });


  it.each([0, 101, 1.5, NaN, Infinity])("rejects maxContextMessages=%s up front", (maxContextMessages) => {
    expect(() => Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      agentId: "agent-1",
      apiKey: "key-1",
      sessionConfig: { maxContextMessages },
    })).toThrow(ValidationError);
  });

  it.each([-1, 1.5, NaN, Infinity])("rejects contextCacheTtlSeconds=%s up front", (contextCacheTtlSeconds) => {
    expect(() => Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      agentId: "agent-1",
      apiKey: "key-1",
      sessionConfig: { contextCacheTtlSeconds },
    })).toThrow(ValidationError);
  });

  it.each([
    { enableContextCache: "true" },
    { enableContextHydration: 1 },
    { enableContextCache: null },
  ])("rejects non-boolean session fields", (sessionConfig) => {
    expect(() => Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      agentId: "agent-1",
      apiKey: "key-1",
      sessionConfig: sessionConfig as never,
    })).toThrow(ValidationError);
  });

  it("rejects an explicit null session config", () => {
    expect(() => Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      agentId: "agent-1",
      apiKey: "key-1",
      sessionConfig: null as never,
    })).toThrow(ValidationError);
  });

});
