import type { AgentSideConnection } from "@agentclientprotocol/sdk";

import type { ACPExtensionHandler } from "./extensions";

export const CURSOR_ASK_QUESTION_METHOD = "cursor/ask_question"
export const CURSOR_CREATE_PLAN_METHOD = "cursor/create_plan"

/**
 * Cursor-specific ACP extension handler.
 *
 * Cursor sends non-standard extension methods and notifications during ACP
 * sessions. This handler implements the expected responses so Cursor can
 * proceed without user interaction:
 *
 * - `cursor/ask_question`: Auto-selects the first available option.
 *   Cursor uses this for inline permission prompts; auto-selecting keeps
 *   the agent flow unblocked.
 *
 * - `cursor/create_plan`: Auto-approves the plan. Cursor asks for plan
 *   confirmation before executing multi-step edits.
 *
 * - `cursor/update_todos`: Forwards the todo list as a session update so
 *   the platform can track task progress.
 *
 * - `cursor/task`: Forwards the task result as a session update when
 *   the task completes with a non-empty result.
 */
export class CursorExtensionHandler implements ACPExtensionHandler {
  public async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (method === CURSOR_ASK_QUESTION_METHOD) {
      const options = Array.isArray(params.options) ? params.options : []
      const first = options.find((option) => !!option && typeof option === "object") as Record<string, unknown> | undefined
      if (!first) {
        return {
          outcome: {
            type: "cancelled",
          },
        }
      }

      return {
        outcome: {
          type: "selected",
          optionId: String(first.optionId ?? first.id ?? "0"),
        },
      }
    }

    if (method === CURSOR_CREATE_PLAN_METHOD) {
      return {
        outcome: {
          type: "approved",
        },
      }
    }

    return null
  }

  public async extNotification(
    method: string,
    params: Record<string, unknown>,
    context: {
      sessionId: string;
      connection: AgentSideConnection;
    },
  ): Promise<void> {
    if (method === "cursor/update_todos") {
      const todos = Array.isArray(params.todos) ? params.todos : []
      const text = todos
        .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === "object")
        .map((todo) => `- [${todo.completed === true ? "x" : " "}] ${String(todo.content ?? "")}`)
        .join("\n")

      if (text.length > 0) {
        await context.connection.sessionUpdate({
          sessionId: context.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text,
            },
          },
        })
      }
      return
    }

    if (method === "cursor/task" && typeof params.result === "string" && params.result.length > 0) {
      await context.connection.sessionUpdate({
        sessionId: context.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `[Task completed] ${params.result}`,
          },
        },
      })
    }
  }
}
