import { describe, expect, it } from "vitest";

import { createClaudeSdkAgent } from "../examples/claude-sdk/01_basic_agent";
import { createCodexAgent } from "../examples/codex/01_basic_agent";

describe("claude/codex examples", () => {
  it("builds a Claude SDK adapter agent without import-time side effects", () => {
    const agent = createClaudeSdkAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("builds a Codex adapter agent without import-time side effects", () => {
    const agent = createCodexAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("builds Codex and Claude SDK agents with character custom sections", () => {
    const codex = createCodexAgent({ customSection: "Tom the cat." });
    const claude = createClaudeSdkAgent({ customSection: "Jerry the mouse." });
    expect(codex).toBeDefined();
    expect(claude).toBeDefined();
  });

  it("imports Tom and Jerry example scripts without side effects", async () => {
    await expect(import("../examples/codex/02_tom_agent")).resolves.toBeDefined();
    await expect(import("../examples/codex/03_jerry_agent")).resolves.toBeDefined();
    await expect(import("../examples/claude-sdk/02_tom_agent")).resolves.toBeDefined();
    await expect(import("../examples/claude-sdk/03_jerry_agent")).resolves.toBeDefined();
  });
});
