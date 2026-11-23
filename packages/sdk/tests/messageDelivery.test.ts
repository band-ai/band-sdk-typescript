import { describe, expect, it } from "vitest";

import { BandError } from "@band-ai/rest-client";
import { RuntimeStateError } from "../src/core/errors";
import { NoopLogger } from "../src/core/logger";
import { DeliveryUnknownError } from "../src/core/deliveryFailedError";
import {
  createToolExecutorError,
  DEFAULT_AGENT_TOOLS_CAPABILITIES,
  isToolExecutorError,
  type AdapterToolsProtocol,
} from "../src/contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import { deliverMessage, classifyFailedAttempt, type MessageDelivery } from "../src/client/rest/messageDelivery";
import type { PlatformChatMessage } from "../src/client/rest/types";
import { deliveringMessages } from "../src/runtime/messageDelivery";

/** A 503: the transport cannot say whether Band took the request. */
function serverError(): BandError {
  return new BandError({ statusCode: 503, body: { error: { code: "server_error", message: "Service unavailable", request_id: "req-1" } } });
}

const stored = {
  id: "msg-1",
  sender_id: "agent-1",
  message_type: "TEXT_MESSAGE",
  content: "held reply",
  mentions: [],
  inserted_at: "2026-01-01T00:00:00.000Z",
} as unknown as PlatformChatMessage;

describe("a post cut short while it settles before a resend", () => {
  it("keeps the failure the transport reported, never the cut", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let findCalls = 0;
    const delivery = deliverMessage({
      post: async () => {
        attempts += 1;
        throw serverError();
      },
      findPosted: async () => {
        findCalls += 1;
        return null;
      },
      stopped: controller.signal,
      logger: new NoopLogger(),
      roomId: "room-1",
      // Abort from the pause hook: the cut lands as soon as the resend pause arms.
      onResendPause: () => controller.abort(),
    });
    const error: unknown = await delivery.catch((thrown: unknown) => thrown);

    // The transport's own uncertainty stands: the failure that surfaces is the one it
    // reported, so the publication settles unknown. The cut may never stand in for it.
    expect(error).toBeInstanceOf(BandError);
    expect(error).not.toBeInstanceOf(RuntimeStateError);
    expect(classifyFailedAttempt(error)).toBe("uncertain");
    expect(attempts).toBe(1);
    // The read-back still ran: a commit in flight may have landed, and settles the post.
    expect(findCalls).toBe(1);
  });

  it("settles a commit that landed while the turn was cut", async () => {
    const controller = new AbortController();
    const delivery = deliverMessage({
      post: async () => {
        throw serverError();
      },
      findPosted: async () => stored,
      stopped: controller.signal,
      logger: new NoopLogger(),
      roomId: "room-1",
      onResendPause: () => controller.abort(),
    });
    const result = await delivery;

    // The room holds the post: it is found, not resent, and nothing failed.
    expect(result).toMatchObject({ found: { id: "msg-1" } });
  });

  it("still surfaces the transport's failure when the cut comes in a later pause", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let pauses = 0;
    const delivery = deliverMessage({
      post: async () => {
        attempts += 1;
        throw serverError();
      },
      stopped: controller.signal,
      logger: new NoopLogger(),
      roomId: "room-1",
      onResendPause: () => {
        pauses += 1;
        // First pause completes so a resend runs; cut on the pause before the next resend.
        if (pauses >= 2) controller.abort();
      },
    });
    const error: unknown = await delivery.catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BandError);
    expect(classifyFailedAttempt(error)).toBe("uncertain");
    // The cut ended the retries; the second resend never ran.
    expect(attempts).toBe(2);
  });
});

describe("same-turn band_send_message coalescing after delivery_unknown", () => {
  const delivery: MessageDelivery = {
    selfId: "agent-1",
    anchor: { id: "anchor-1", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    attributed: { has: () => false, add: () => undefined },
  };

  function toolsWith(execute: AdapterToolsProtocol["executeToolCall"]): AdapterToolsProtocol {
    return new Proxy({} as AdapterToolsProtocol, {
      get(_target, key) {
        if (key === "executeToolCall") return execute;
        if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
        if (typeof key === "string") return async () => ({});
        return undefined;
      },
    });
  }

  it("keeps the coalesce key after delivery_unknown so a second same executeToolCall does not post again", async () => {
    let posts = 0;
    const unknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-1" },
    });
    const tools = deliveringMessages(
      toolsWith(async (toolName) => {
        if (toolName === SEND_MESSAGE_TOOL_NAME) {
          posts += 1;
          return unknown;
        }
        return {};
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "held", mentions: ["@a"] });
    const second = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "held", mentions: ["@a"] });

    expect(posts).toBe(1);
    expect(second).toBe(first);
    expect(isToolExecutorError(first)).toBe(true);
    expect(first).toMatchObject({ details: { kind: DeliveryUnknownError.KIND } });
  });

  it("still clears after a definite refusal so a retry can post", async () => {
    let posts = 0;
    const tools = deliveringMessages(
      toolsWith(async (toolName) => {
        if (toolName !== SEND_MESSAGE_TOOL_NAME) return {};
        posts += 1;
        if (posts === 1) {
          return createToolExecutorError({
            errorType: "ToolExecutionError",
            toolName: SEND_MESSAGE_TOOL_NAME,
            message: "refused",
          });
        }
        return { success: true, id: "posted" };
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "retry", mentions: ["@a"] });
    const second = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "retry", mentions: ["@a"] });

    expect(posts).toBe(2);
    expect(isToolExecutorError(first)).toBe(true);
    expect(second).toMatchObject({ success: true, id: "posted" });
  });

  it("posts each successful direct sendMessage: only tool-door successes stay coalesced", async () => {
    let posts = 0;
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "sendMessage") {
            return async (content: string) => {
              posts += 1;
              return { success: true, id: `posted-${posts}`, content };
            };
          }
          if (key === "executeToolCall") return async () => ({});
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    await expect(tools.sendMessage("again", ["@a"])).resolves.toMatchObject({ id: "posted-1" });
    await expect(tools.sendMessage("again", ["@a"])).resolves.toMatchObject({ id: "posted-2" });
    expect(posts).toBe(2);
  });

  it("after tool-door success, same-content sendMessage still POSTs (send ignores retained tool success)", async () => {
    let posts = 0;
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "executeToolCall") {
            return async (toolName: string) => {
              if (toolName === SEND_MESSAGE_TOOL_NAME) {
                posts += 1;
                return { success: true, id: "tool-posted" };
              }
              return {};
            };
          }
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              return { success: true, id: "send-posted" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "same", mentions: ["@a"] });
    await expect(tools.sendMessage("same", ["@a"])).resolves.toMatchObject({ id: "send-posted" });
    expect(posts).toBe(2);
  });

  it("keeps tool-door success coalesced for a second same-content executeToolCall", async () => {
    let posts = 0;
    const tools = deliveringMessages(
      toolsWith(async (toolName) => {
        if (toolName === SEND_MESSAGE_TOOL_NAME) {
          posts += 1;
          return { success: true, id: `tool-${posts}` };
        }
        return {};
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "dedupe",
      mentions: ["@a"],
    });
    const second = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "dedupe",
      mentions: ["@a"],
    });
    expect(posts).toBe(1);
    expect(second).toBe(first);
    expect(first).toMatchObject({ id: "tool-1" });
  });

  it("joins in-flight cross-door same-content sends into one POST", async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "executeToolCall") {
            return async (toolName: string) => {
              if (toolName !== SEND_MESSAGE_TOOL_NAME) return {};
              posts += 1;
              await gate;
              return { success: true, id: "tool-inflight" };
            };
          }
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              await gate;
              return { success: true, id: "send-inflight" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    const viaTool = tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "race",
      mentions: ["@a"],
    });
    const viaSend = tools.sendMessage("race", ["@a"]);
    release();
    const [toolResult, sendResult] = await Promise.all([viaTool, viaSend]);
    expect(posts).toBe(1);
    expect(toolResult).toBe(sendResult);
    expect(toolResult).toMatchObject({ id: "tool-inflight" });
  });

  it("treats omitted tool mentions and sendMessage([]) as the same key after delivery_unknown", async () => {
    let posts = 0;
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-null-empty" },
    });
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "executeToolCall") {
            return async (toolName: string) => {
              if (toolName === SEND_MESSAGE_TOOL_NAME) {
                posts += 1;
                return toolUnknown;
              }
              return {};
            };
          }
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              return { success: true, id: "should-not-post" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "held" });
    expect(isToolExecutorError(first)).toBe(true);

    const error: unknown = await tools.sendMessage("held", []).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect((error as DeliveryUnknownError).publicationId).toBe("pub-null-empty");
    expect(posts).toBe(1);
  });

  it("treats reordered mentions as the same key after delivery_unknown", async () => {
    let posts = 0;
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-order" },
    });
    const tools = deliveringMessages(
      toolsWith(async (toolName) => {
        if (toolName === SEND_MESSAGE_TOOL_NAME) {
          posts += 1;
          return toolUnknown;
        }
        return {};
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "held",
      mentions: ["@a", "@b"],
    });
    const second = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "held",
      mentions: ["@b", "@a"],
    });
    expect(posts).toBe(1);
    expect(second).toBe(first);
  });

  it("treats duplicate mention tokens and a uniqued retry as the same key after delivery_unknown", async () => {
    let posts = 0;
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-dup" },
    });
    const tools = deliveringMessages(
      toolsWith(async (toolName) => {
        if (toolName === SEND_MESSAGE_TOOL_NAME) {
          posts += 1;
          return toolUnknown;
        }
        return {};
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "held",
      mentions: ["@a", "@a"],
    });
    const second = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "held",
      mentions: ["@a"],
    });
    expect(posts).toBe(1);
    expect(second).toBe(first);
  });

  it("treats @handle string and {handle} MentionReference as the same key after delivery_unknown", async () => {
    let posts = 0;
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-shape" },
    });
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "executeToolCall") {
            return async (toolName: string) => {
              if (toolName === SEND_MESSAGE_TOOL_NAME) {
                posts += 1;
                return toolUnknown;
              }
              return {};
            };
          }
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              return { success: true, id: "should-not-post" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "held",
      mentions: ["@a"],
    });
    expect(isToolExecutorError(first)).toBe(true);

    // {handle} (with or without id) prefers the handle field — same token as "@a".
    const error: unknown = await tools
      .sendMessage("held", [{ id: "user-1", handle: "a" }])
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect((error as DeliveryUnknownError).publicationId).toBe("pub-shape");
    expect(posts).toBe(1);
  });

  it("keeps id-only MentionReference and @handle as distinct keys without a roster", async () => {
    // Contract: coalesce has no participant map, so id-only vs bare @handle do
    // not share a key even when they name the same peer. AgentTools resolves
    // strings at send time; this layer only unifies when a handle-like field is
    // already on the same object as the id.
    let posts = 0;
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-id-only" },
    });
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "executeToolCall") {
            return async (toolName: string) => {
              if (toolName === SEND_MESSAGE_TOOL_NAME) {
                posts += 1;
                return toolUnknown;
              }
              return {};
            };
          }
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              return { success: true, id: "second-post" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "held",
      mentions: [{ id: "user-1" }],
    });
    const second = await tools.sendMessage("held", ["@alice"]);
    expect(second).toMatchObject({ id: "second-post" });
    expect(posts).toBe(2);
  });

  it("joins in-flight cross-door sends that settle delivery_unknown into one POST", async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-inflight-unknown" },
    });
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "executeToolCall") {
            return async (toolName: string) => {
              if (toolName !== SEND_MESSAGE_TOOL_NAME) return {};
              posts += 1;
              await gate;
              return toolUnknown;
            };
          }
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              await gate;
              return { success: true, id: "should-not-post" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    const viaTool = tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "race-unknown",
      mentions: ["@a"],
    });
    const viaSend = tools.sendMessage("race-unknown", ["@a"]).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    release();
    const [toolResult, sendResult] = await Promise.all([viaTool, viaSend]);
    expect(posts).toBe(1);
    expect(isToolExecutorError(toolResult)).toBe(true);
    expect(toolResult).toMatchObject({
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-inflight-unknown" },
    });
    expect(sendResult.ok).toBe(false);
    if (!sendResult.ok) {
      expect(sendResult.error).toBeInstanceOf(DeliveryUnknownError);
      expect((sendResult.error as DeliveryUnknownError).publicationId).toBe("pub-inflight-unknown");
    }
  });

  it("coalesces direct sendMessage after DeliveryUnknown so a second same-content send does not POST again", async () => {
    let posts = 0;
    const unknown = new DeliveryUnknownError(serverError(), "pub-2");
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              throw unknown;
            };
          }
          if (key === "executeToolCall") return async () => ({});
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    await expect(tools.sendMessage("held", ["@a"])).rejects.toBe(unknown);
    await expect(tools.sendMessage("held", ["@a"])).rejects.toBe(unknown);
    expect(posts).toBe(1);

    // executeToolCall path still coalesces on the shared map.
    let toolPosts = 0;
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-3" },
    });
    const viaTool = deliveringMessages(
      toolsWith(async (toolName) => {
        if (toolName === SEND_MESSAGE_TOOL_NAME) {
          toolPosts += 1;
          return toolUnknown;
        }
        return {};
      }),
      delivery,
    );
    const first = await viaTool.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "tool-held", mentions: ["@b"] });
    const second = await viaTool.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "tool-held", mentions: ["@b"] });
    expect(toolPosts).toBe(1);
    expect(second).toBe(first);
  });

  it("rejects sendMessage after executeToolCall delivery_unknown instead of resolving the tool error as success", async () => {
    let posts = 0;
    const toolUnknown = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: SEND_MESSAGE_TOOL_NAME,
      message: "delivery unknown",
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-cross" },
    });
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "executeToolCall") {
            return async (toolName: string) => {
              if (toolName === SEND_MESSAGE_TOOL_NAME) {
                posts += 1;
                return toolUnknown;
              }
              return {};
            };
          }
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              return { success: true, id: "should-not-post" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    const first = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "cross", mentions: ["@a"] });
    expect(isToolExecutorError(first)).toBe(true);
    expect(first).toMatchObject({ details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-cross" } });

    const error: unknown = await tools.sendMessage("cross", ["@a"]).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect((error as DeliveryUnknownError).publicationId).toBe("pub-cross");
    expect(posts).toBe(1);
  });

  it("resolves executeToolCall after sendMessage DeliveryUnknown instead of throwing the rejection", async () => {
    let posts = 0;
    const unknown = new DeliveryUnknownError(serverError(), "pub-reverse");
    const tools = deliveringMessages(
      new Proxy({} as AdapterToolsProtocol, {
        get(_target, key) {
          if (key === "sendMessage") {
            return async () => {
              posts += 1;
              throw unknown;
            };
          }
          if (key === "executeToolCall") {
            return async () => {
              posts += 1;
              return { success: true, id: "should-not-post" };
            };
          }
          if (key === "capabilities") return DEFAULT_AGENT_TOOLS_CAPABILITIES;
          if (typeof key === "string") return async () => ({});
          return undefined;
        },
      }),
      delivery,
    );

    await expect(tools.sendMessage("reverse", ["@a"])).rejects.toBe(unknown);

    const viaTool = await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, {
      content: "reverse",
      mentions: ["@a"],
    });
    expect(isToolExecutorError(viaTool)).toBe(true);
    expect(viaTool).toMatchObject({
      details: { kind: DeliveryUnknownError.KIND, publicationId: "pub-reverse" },
    });

    const stillUnknown: unknown = await tools.sendMessage("reverse", ["@a"]).catch((thrown: unknown) => thrown);
    expect(stillUnknown).toBe(unknown);
    expect(posts).toBe(1);
  });
});
