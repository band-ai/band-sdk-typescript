import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LangGraphAdapter } from "../src/adapters/langgraph";
import { createDeferred } from "../src/core/deferred";
import { trackTurn } from "../src/core/turn";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { expectTurnFailed, FakeTools, MISSING_REPLY, reportedFailures } from "./testUtils";
import { CLOSING_TEXT, describeCustomToolEffect, turnInput } from "./turnOutcomeContract";

interface InvokableTool {
  name: string;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

function toolFrom(tools: unknown[], name: string): InvokableTool {
  const tool = (tools as InvokableTool[]).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool;
}

const definition = (overrides: Partial<CustomToolDef> = {}): CustomToolDef => ({
  name: "write_marker", schema: z.object({}), handler: () => ({ ok: true }), effect: "act", ...overrides,
});

function scriptedAdapter(def: CustomToolDef, run: (tool: InvokableTool) => Promise<unknown>, closing = "") {
  return new LangGraphAdapter({
    customTools: [def],
    emitExecutionEvents: false,
    graphFactory: (tools) => ({
      async invoke() {
        await run(toolFrom(tools, def.name.trim()));
        return { messages: closing ? [["assistant", closing]] : [] };
      },
    }),
  });
}

describeCustomToolEffect("LangGraphAdapter (real LangChain)", async (def, tools) => {
  const adapter = scriptedAdapter(def, (tool) => tool.invoke({}));
  await adapter.onEvent(turnInput(tools));
});

describe("portable LangGraph tools", () => {
  it("publishes input schema and applies the original strict schema, defaults and transform once", async () => {
    const transform = vi.fn((value: string) => `${value}!`);
    const handler = vi.fn((args) => args);
    const def = definition({ name: " write_marker ", schema: z.strictObject({
      payload: z.strictObject({ text: z.string().transform(transform) }), count: z.number().default(2),
    }), handler });
    const adapter = scriptedAdapter(def, async (tool) => {
      expect(await tool.invoke({ payload: { text: "hello" } })).toBe('{"payload":{"text":"hello!"},"count":2}');
      expect(transform).toHaveBeenCalledOnce();
      await expect(tool.invoke({ payload: { text: "hello" }, extra: true })).rejects.toThrow();
      await expect(tool.invoke({})).rejects.toThrow();
    });
    await adapter.onEvent(turnInput(new FakeTools()));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ payload: { text: "hello!" }, count: 2 });

  });

  it.each(["act", "reply", "decline", "observe"] as const)("handles %s and final text", async (effect) => {
    const tools = new FakeTools();
    const adapter = scriptedAdapter(definition({ effect }), (tool) => tool.invoke({}), CLOSING_TEXT);
    await adapter.onEvent(turnInput(tools));
    expect(tools.messages).toEqual(effect === "reply" || effect === "decline" ? [] : [CLOSING_TEXT]);
  });

  it.each([{ ok: false }, "eRrOr: refused", "Error executing tool: refused"])("does not credit failed output %j", async (output) => {
    const tools = new FakeTools();
    let result: unknown;
    const adapter = scriptedAdapter(definition({ handler: () => output }), async (tool) => {
      result = await tool.invoke({});
    });
    await expectTurnFailed(adapter.onEvent(turnInput(tools)));
    expect(result).toBe(typeof output === "string" ? output : JSON.stringify(output));
    expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
  });

  it("keeps an earlier successful effect after a caught handler failure", async () => {
    let calls = 0;
    const adapter = scriptedAdapter(definition({ handler: () => {
      if (++calls === 2) throw new Error("write failed");
      return false;
    } }), async (tool) => {
      expect(await tool.invoke({})).toBe("false");
      await expect(tool.invoke({})).rejects.toThrow("write failed");
    });
    await adapter.onEvent(turnInput(new FakeTools()));
    expect(calls).toBe(2);
  });

  it("reports a terminal graph failure even after a successful action", async () => {
    const tools = new FakeTools();
    const adapter = scriptedAdapter(definition(), async (tool) => {
      await tool.invoke({});
      throw new Error("provider failed");
    });
    await expectTurnFailed(adapter.onEvent(turnInput(tools)));
    expect(reportedFailures(tools.events)).toEqual([{ content: "provider failed", provider: "langgraph" }]);
  });

  it.each([false, true])("passes native tools unchanged in a mixed graph (stream=%s)", async (stream) => {
    const native = { name: "native", invoke: vi.fn(async () => "native result") };
    const handler = vi.fn(() => "portable result");
    const adapter = new LangGraphAdapter({
      customTools: [definition({ handler })], additionalTools: [native], emitExecutionEvents: stream,
      graphFactory: (tools) => {
        expect(tools).toContain(native);
        const invokeTools = async () => {
          expect(await toolFrom(tools, "native").invoke({})).toBe("native result");
          expect(await toolFrom(tools, "write_marker").invoke({})).toBe("portable result");
        };
        return stream ? { async *streamEvents() { await invokeTools(); } } : { async invoke() { await invokeTools(); return { messages: [] }; } };
      },
    });
    await adapter.onEvent(turnInput(new FakeTools()));
    expect(handler).toHaveBeenCalledOnce();
    expect(native.invoke).toHaveBeenCalledOnce();
  });

  it("captures distinct turns even when an older tool finishes after another turn", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const wrappers: InvokableTool[] = [];
    let calls = 0;
    const adapter = new LangGraphAdapter({
      customTools: [definition({ handler: async () => {
        if (++calls === 1) { started.resolve(); await release.promise; }
        return "done";
      } })],
      graphFactory: (tools) => {
        const wrapper = toolFrom(tools, "write_marker");
        wrappers.push(wrapper);
        return { async invoke() { await wrapper.invoke({}); return { messages: [] }; } };
      },
    });
    const first = trackTurn(new FakeTools());
    const second = trackTurn(new FakeTools());
    const pending = adapter.onMessage(turnInput(first).message, first, turnInput(first).history, null, null, { roomId: "room-1", isSessionBootstrap: false });
    await started.promise;
    await adapter.onMessage(turnInput(second).message, second, turnInput(second).history, null, null, { roomId: "room-1", isSessionBootstrap: false });
    expect(second.turn.verdict()).toBe("complete");
    expect(first.turn.verdict()).toBe("missing_reply");
    release.resolve();
    await pending;
    expect(first.turn.verdict()).toBe("complete");
    expect(wrappers[0]).not.toBe(wrappers[1]);
  });
});
