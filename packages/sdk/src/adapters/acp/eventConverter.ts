import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { AgentFailure } from "@band-ai/band-sdk-core";

import { parseToolCall, parseToolResult } from "../../converters/shared";
import type { PlatformMessage } from "../../runtime/types";
import { redactCredentialText } from "../../core/sensitiveTerms";
import { decodeACPFailure } from "./failure";

export class EventConverter {
  public static convert(message: PlatformMessage, failure?: AgentFailure): SessionUpdate | null {
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
            text: `[Error] ${redactCredentialText(message.content)}`,
          },
          _meta: (failure ?? decodeACPFailure(message)).toExtensionData(),
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
