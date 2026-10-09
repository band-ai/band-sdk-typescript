/** The question that picks a session's agent, and what the user's answer picks. */
import { describe, expect, it } from "vitest";

import { agentQuestion, pickedAgent } from "../../src/question";
import { CLOSED, pick } from "../support/channelClient";
import { sessionStatus } from "../support/claudeCodeDirs";

const MAIN = { agentId: "agent-main", apiKey: "key-main", handle: "alex/main" };
const PLAIN = { agentId: "agent-plain", apiKey: "key-plain", handle: null };

/** The options the question offers, as the user reads them. */
function options(question: ReturnType<typeof agentQuestion>): unknown {
  return (question.requestedSchema.properties.agent as { oneOf: unknown }).oneOf;
}

describe("the agent question", () => {
  it("offers each saved agent by name and handle", () => {
    expect(options(agentQuestion({ main: MAIN, plain: PLAIN }, []))).toEqual([
      { const: "main", title: "main (@alex/main)" },
      { const: "plain", title: "plain" },
    ]);
  });

  it("says where another session holds an agent, and that picking it takes it over", () => {
    const holder = sessionStatus({ agentId: MAIN.agentId, projectDir: "/repo/api" });

    expect(options(agentQuestion({ main: MAIN }, [holder]))).toEqual([
      { const: "main", title: "main (@alex/main) — in use (session in /repo/api); picking takes it over" },
    ]);
  });

  it("doesn't count a session that is off as holding its last agent", () => {
    const off = sessionStatus({ agentId: MAIN.agentId, state: "off" });

    expect(options(agentQuestion({ main: MAIN }, [off]))).toEqual([{ const: "main", title: "main (@alex/main)" }]);
  });
});

describe("the answer", () => {
  it("picks the agent the user chose", () => {
    expect(pickedAgent(pick("main"))).toBe("main");
  });

  it("picks none when the user closes or declines the question", () => {
    expect(pickedAgent(CLOSED)).toBeUndefined();
    expect(pickedAgent({ action: "decline" })).toBeUndefined();
  });
});
