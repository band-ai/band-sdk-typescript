import { describe, expect, it } from "vitest";

import { NoopLogger } from "@band-ai/sdk/core";

import { MessageMemory } from "../../src/messages";
import { BOARD_RULE_BUDGET, CHANNEL_INSTRUCTIONS } from "../../src/prompt";
import { bandTools, CLAUDE_CODE_TEXT_LIMIT, type ToolContext } from "../../src/tools";
import { WorkingIndicator } from "../../src/working";
import { FakeRestApi } from "../../../../packages/sdk/tests/testUtils";

// Descriptions name the agent, so measure them with a long handle.
const LONG_HANDLE = `@${"o".repeat(100)}/${"a".repeat(100)}`;

describe("what Claude Code would cut", () => {
  it(`keeps the instructions within ${CLAUDE_CODE_TEXT_LIMIT} characters, leaving ${BOARD_RULE_BUDGET} for the board rule`, () => {
    expect(CHANNEL_INSTRUCTIONS.length).toBeLessThanOrEqual(CLAUDE_CODE_TEXT_LIMIT - BOARD_RULE_BUDGET);
  });

  it(`keeps every tool description within ${CLAUDE_CODE_TEXT_LIMIT} characters`, () => {
    const rest = new FakeRestApi();
    const context: ToolContext = {
      link: { agentId: "agent-1", rest, listAllChats: async () => [] },
      self: { id: "agent-1", handle: LONG_HANDLE },
      memory: new MessageMemory(),
      working: new WorkingIndicator({}, new NoopLogger()),
      logger: new NoopLogger(),
    };

    for (const tool of bandTools(context)) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(CLAUDE_CODE_TEXT_LIMIT);
    }
  });
});
