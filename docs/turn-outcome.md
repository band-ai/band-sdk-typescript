# Turn outcome

Every turn an adapter handles ends in one of two verdicts, decided by
band-sdk-core's rule, the same rule the Python SDK uses:

- **complete**: the turn replied, declined with `band_no_reply`, did real work
  (an `act` tool), was settled by the adapter, or already reported a failure;
- **missing_reply**: none of those happened.

A `missing_reply` turn is reported once to the room, with core's
`missingReplyMessage()` text and provider `band-runtime`, and its delivery is
marked FAILED. There is no nudge and no second attempt.

`SimpleAdapter.onEvent` creates each turn's ledger and judges it after
`onMessage` returns, so every adapter built on `SimpleAdapter` is judged
unless it opts out. `A2AAdapter`, `A2AGatewayAdapter`, `BandACPServerAdapter`
and `ParlantAdapter` opt out, because they relay another agent's answer rather
than owe one. A `LangGraphAdapter` with a static `graph` is also exempt,
because it has no Band tools to answer with. Synthetic turns, such as contact
events put to the hub room, are never judged.

## `band_no_reply`

The model ends a turn on purpose without posting anything by calling
`band_no_reply` (an optional `reason` is logged locally). Its name,
description and parameter come from core's `noReplyTool()`, and the base
prompt teaches it next to `band_send_message`. A declined turn is complete,
and its closing text is not relayed.

## What counts

The tools a turn receives (`TurnTools`, so `tools.turn` is its `Turn`) record
on the tool methods themselves. A model's `executeToolCall`, MCP, a direct
`tools.sendMessage` or `tools.storeMemory`, and `deliverReply` all count, by
core's effect table (`bandToolEffects()`):

| Effect | Tools | Completes the turn |
|---|---|---|
| `observe` | reads, `band_send_event` | no |
| `act` | `band_add_participant`, `band_store_memory`, … | yes |
| `reply` | `band_send_message` | yes, and suppresses the relay |
| `decline` | `band_no_reply` | yes, and suppresses the relay |

A call that failed (a rejection, `{ ok: false }`, a `ToolExecutorError`) or a
blank `band_send_message` records nothing. A thought or other event is
visible in the room, but it never answers the turn.

## Text the adapter writes itself

A prompt, a busy note, or a command's status reply is not the model's answer.
Post it with `tools.sendNotice` (or `deliverNotice` / `replyToSender`): it
posts like `sendMessage` but never counts as the reply, so it can't suppress
the relay of the model's real answer or hide a missing one. When such a turn
needs no other answer, call `tools.turn.settle()`:

```ts
import { SimpleAdapter, type HistoryProvider, type PlatformMessage, type TurnTools } from "@band-ai/sdk";

class EchoAdapter extends SimpleAdapter<HistoryProvider> {
  protected readonly provider = "echo";

  public async onMessage(message: PlatformMessage, tools: TurnTools): Promise<void> {
    const sender = [{ id: message.senderId }];
    if (message.content.trim() === "/ping") {
      await tools.sendNotice("pong", sender);
      tools.turn.settle();
      return;
    }
    await tools.sendMessage(`Received: ${message.content}`, sender);
  }
}
```

The full example is `packages/sdk/examples/custom-adapter/custom-adapter.ts`.
A `GenericAdapter` handler gets the same `tools`: its `sendMessage` is the
reply, and a handler that answers nothing on purpose calls
`tools.turn.settle()`.

## Relaying the model's closing text

Tool-loop adapters relay the model's final text when it never answered
through a tool. Use `relayReply(tools, text, mentions)`: it posts `text`
unless the turn already replied or declined, and returns whether it posted.

## Turns that outlive `onMessage`

An adapter that releases a turn's request while the turn waits on the room
(OpenCode and Cursor, waiting on a decision) calls `tools.turn.detach()`.
`onEvent` then skips the judgement and the delivery is marked PROCESSED. At
the turn's real end the adapter calls `reportUnsettledTurn(tools, logger)`,
which posts the missing-reply failure when the verdict is `missing_reply`.
A turn cancelled by room cleanup is not reported.

## Band tools in another process (ACP)

An ACP agent started with `enableMcpTools: false` reaches Band through an MCP
server of its own, such as an external band-mcp, so its Band calls never pass
through the turn's tools. The ACP adapter then records them from the session
stream instead: each `tool_call` naming a Band tool that reports `completed`,
directly or through a `tool_result` with the same id. It reads the name from
the MCP invocation in `raw_input` (codex-acp, Cursor) or the title, and
accepts the `band-<tool>` spelling and band-mcp's legacy
`create_agent_chat_message`. With the SDK's own backend on, the stream is not
read, because the tools already record each call.

## Custom tools

A `CustomToolDef` may declare `effect`; the default is `observe`, which never
completes a turn. Declare `act` for a tool with a real side effect (the
Linear tools that change Linear do), or `reply` for one that posts the turn's
answer itself.

Some tools can't declare one and always count as `observe`:

- OpenCode's custom tools, which are registered once for every room, so no
  turn is in scope when they run;
- ClaudeSDK's `additionalMcpTools`, which are raw MCP registrations;
- LangGraph's `additionalTools`, which are opaque to the SDK.
