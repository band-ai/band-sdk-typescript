import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

import { parseToolCall, parseToolResult } from "../../converters/shared";
import type { PlatformMessage } from "../../runtime/types";

/** Converts a Band room message into the matching ACP `SessionUpdate` for an editor. */
export class EventConverter {
  public static convert(message: PlatformMessage): SessionUpdate | null {
    switch (message.messageType) {
      case "text":
        return {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: message.content,
          },
        }
      case "thought":
        return {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: message.content,
          },
        }
      case "tool_call":
        return this.convertToolCall(message.content)
      case "tool_result":
        return this.convertToolResult(message.content)
      case "error":
        return {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `[Error] ${message.content}`,
          },
        }
      case "task":
        return {
          sessionUpdate: "plan",
          entries: [{
            content: message.content,
            priority: "medium",
            status: "in_progress",
          }],
        }
      default:
        return null
    }
  }

  private static convertToolCall(value: string): SessionUpdate {
    const parsed = parseToolCall(value)
    if (!parsed) {
      return {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: value,
        },
      }
    }

    return {
      sessionUpdate: "tool_call",
      toolCallId: parsed.toolCallId,
      title: parsed.name,
      kind: "other",
      status: "in_progress",
      rawInput: parsed.args,
    }
  }

  private static convertToolResult(value: string): SessionUpdate {
    const parsed = parseToolResult(value)
    if (!parsed) {
      return {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: value,
        },
      }
    }

    const textBlock: ContentBlock = {
      type: "text",
      text: parsed.output,
    }
    const content: ToolCallContent[] = [{
      type: "content",
      content: textBlock,
    }]

    return {
      sessionUpdate: "tool_call_update",
      toolCallId: parsed.toolCallId,
      status: parsed.isError ? "failed" : "completed",
      rawOutput: parsed.output,
      content,
    }
  }
}
