import { describe, expect, it } from "vitest";

import { Agent } from "../src/agent/Agent";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { ValidationError } from "../src/core/errors";

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
  it.each([-1, 1.5, 4_294_967_296])("rejects maxMessageRetries=%s up front", (maxMessageRetries) => {
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
});
