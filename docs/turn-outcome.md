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
than owe one. A `LangGraphAdapter` with only a static `graph` (no `graphFactory`) is also
exempt, because it has no Band tools to answer with. Synthetic turns, such as contact
events put to the hub room, are never judged.

## `band_no_reply`

The model ends a turn on purpose without posting anything by calling
`band_no_reply` (an optional `reason` is logged locally). Its name,
description and parameter come from core's `noReplyTool()`, and the base
prompt teaches it next to `band_send_message`. A declined turn is complete,
and its closing text is not relayed.

An adapter that runs its own tool loop stops after the round in which a
decline landed, any tool whose effect is `decline`, without asking the model
again. If another call in that round failed, the loop continues so the model
sees the failure. `ToolCallingAdapter` (OpenAI, Anthropic, Gemini, Vercel AI
SDK), `GoogleADKAdapter` and `LangGraphAdapter`'s built-in graph share this
rule through Core's `RoundOutcome`. Native bookkeeping in
`adapters/shared/toolRounds.ts` records landed effects and actual
failures on each call's originating round, including nested Band calls. Only a complete round can stop before the
model's next call; `tests/toolRoundContract.ts` holds the scenarios they owe.
ADK tracks announced call IDs and observes each result once before declaring
its round complete. Missing, repeated or ambiguous call IDs cannot authorize
early stop. Injected runners only receive this guarantee when they follow the
same call/response protocol.
LangGraph's built-in graph stops in its pre-model hook with an empty
interrupt, as a static `interruptAfter` would. The run ends cleanly after the
round's tool messages are saved, so a checkpointed room's next turn continues
from them. A call that threw, named no tool or had invalid arguments counts as
failed, as ToolNode reports it. Graphs passed as `graph` or `graphFactory`,
and agents that run their own loop (Letta's server, Claude SDK, Codex, ACP,
OpenCode), keep their own control flow.

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
blank `band_send_message` records nothing. Blank is the platform's rule: text
with no letter, number, punctuation or symbol. A thought or other event is
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
through a tool. ACP joins the text runs around its tool calls into that one
answer. Use `relayReply(tools, text, mentions)`: it posts `text`
unless the turn already replied or declined, and returns whether it posted.

The base prompt still tells the model that plain text is never delivered, as
the Python SDK's does. The relay is a fallback, not a channel to steer toward:
without that line, models more often send their closing narration as a second
`band_send_message`.

## Turns that outlive `onMessage`

An adapter that releases a turn's request while the turn waits on the room
(OpenCode and Cursor, waiting on a decision) uses `runUntilReleased`.
The shared helper retains the operation and supplies a normal-completion
callback which runs before provider cleanup. It detaches with the complete
operation promise, including judgment and reply delivery. `onEvent` then skips
attached judgment and the delivery is marked PROCESSED. The runtime holds the
room until the turn really ends: an ordinary message that
arrives meanwhile waits, unmarked, and runs as its own turn afterwards, in
arrival order. Only a decision reply the adapter recognises
(`isControlMessage`) runs during the hold. A decision reply sent while the
socket was down waits on Band like any other message, so the held turn ends
when its ask expires, and the late reply then runs with a no-longer-pending
notice. The shared completion boundary applies the same verdict as attached
turns, reporting a missing reply only on normal completion. Provider failures
and room-cleanup cancellation keep their own outcome. Synthetic turns and
exempt adapters are never judged.

Custom adapters may still use `turn.detach(untilEnded?)` and
`reportUnsettledTurn(tools, logger, { roomId })`. Bare `detach()` retains its
legacy behavior: no runtime hold is installed without a completion promise.
Completion is separate from backend readiness. Existing provider isolation
and replacement policies remain unchanged; this helper does not turn a
best-effort stop into proof that a backend is safe to reuse.

OpenCode ends a turn on a bare approval or question reject, before the model
can answer. So the adapter sends every decided reject (a room's reject, an
auto-decline, an expired ask) with feedback: a permission reject carries a
message, and a declined question is answered with a decline. Either hands the
decision back to the model, whose answer then completes the turn.

## Band tools in another process (ACP)

An ACP agent started with `enableMcpTools: false` reaches Band through an MCP
server of its own, such as an external band-mcp, so its Band calls never pass
through the turn's tools. The ACP adapter then records them from the session
stream instead: each `tool_call` naming a Band tool that reports `completed`,
directly or through a `tool_result` with the same id. It reads the name from
the MCP invocation in `raw_input` (codex-acp, Cursor) or the title, and
accepts the `band-<tool>` spelling and band-mcp's legacy
`create_agent_chat_message`. An update that carries a title or raw input
renames the call: Cursor opens an MCP call as "MCP: tool" and names it only
there. With the SDK's own backend on, the stream is not
read, because the tools already record each call.

## Custom tools

A `CustomToolDef` may declare `effect`; omitted means `observe`, which never
completes a turn. `act` completes it after a successful side effect and still
permits final-text relay. `reply` and `decline` complete it and suppress relay.
Only successful calls record an effect: invalid arguments, thrown errors,
`{ ok: false }`, typed executor errors and legacy error strings earn no credit.
A later failed tool call does not erase earlier credit, but terminal provider
or reply-delivery failures still fail the turn.

LangGraph and ClaudeSDK accept portable definitions through `customTools`:

```ts
import { ClaudeSDKAdapter, LangGraphAdapter, type CustomToolDef } from "@band-ai/sdk";
import { z } from "zod";

const customTools: CustomToolDef[] = [{
  name: "create_ticket",
  description: "Create a support ticket",
  schema: z.object({ title: z.string() }),
  handler: ({ title }) => createTicket(String(title)),
  effect: "act",
}];

const langgraph = new LangGraphAdapter({ llm, customTools });
const claude = new ClaudeSDKAdapter({ customTools });
```

LangGraph builds fresh wrappers for the built-in graph or `graphFactory` on
each turn. A nonempty `customTools` list requires one of those paths; a static
`graph` alone cannot receive tools. Claude requires MCP tools enabled. Both
adapters reject invalid definitions and collisions with active Band/native
tool names; empty lists preserve existing behavior.

Claude and OpenCode register custom tools once, routing calls by the required
`room_id` argument. That name is reserved: do not include it in the business
schema. Routing removes it before the original schema validates the arguments.
Claude binds tools for the active turn and clears them on every exit. A call
already running retains its captured turn even during cleanup or replacement.
The bridge trusts `room_id`, including another active room; it does not
identify a call's originating query or distinguish a late call from an old
query after a replacement starts.

The existing JSON schema conversion publishes input schemas, so original Zod
runtime transforms run once per execution. Claude's JSON-to-Zod bridge is an
approximation; the original business schema validates before the handler.
Claude portable tools preserve undeclared arguments so that original schema
controls whether to retain, strip, or reject them.
Published and runtime acceptance can differ, and schema generation may invoke
dynamic default/catch callbacks separately from execution.

Opaque Claude `additionalMcpTools` and LangGraph `additionalTools` gain no
automatic custom-effect credit. Their calls may still count if they use the
active turn's Band tools. Resolved failure values retain existing result
serialization; effect credit is separate from an MCP transport error flag.


## Lifecycle conformance

The [Core lifecycle traces](https://github.com/band-ai/band-sdk-core/blob/main/crates/core/docs/turn-lifecycle.md)
define observable ordering across SDKs. TypeScript's native proofs are:

| Trace | TypeScript boundary and coverage |
| --- | --- |
| TL1 | `turn.test.ts` shared completion tests; Cursor/OpenCode flow tests send follow-up input after reply delivery but before provider completion. |
| TL2 | Cursor/OpenCode flow tests pass decision controls past ordinary held messages and preserve queued arrival order. |
| TL3, TL4, TL6 | Python refusal notifications; TypeScript holds admission on the actual completion promise and adds no refusal/recovery notification or write-backoff change. Settled completion/handoff races are exercised in `turn.test.ts`. |
| TL5 | `execution.test.ts` settles a retired execution's hold while its replacement remains held, passes a control, then releases only the replacement's promise. Cursor flow tests also remove/rejoin held rooms and reject retired-process asks. |
| TL7, TL8 | No backend recovery path changes here. Existing ACP/Cursor connection retirement, Codex client replacement, and OpenCode session abandonment retain their current policies and regression suites. These tests do not prove termination of remote/native side effects. Claude attached admission is not loosened. |
| TL9, TL10 | `toolRoundContract.ts` runs on ToolCallingAdapter, the real ADK runner and real LangGraph graph; `google-adk-loop.test.ts` gates a slow sibling and splits response batches. |
| TL11 | `turn.test.ts` completes an old callback after a new round starts, rejects ambiguous/reused IDs, and ignores duplicate/foreign results; ADK split-response tests exercise the runner bridge. |
| TL12 | `turn.test.ts` retains bare `detach()`; graph/graphFactory and opaque provider loops keep their own scheduling. The existing turn-outcome registry preserves synthetic and bridge exemptions. |
