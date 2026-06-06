# `custom-adapter/` — write your own adapter

`SimpleAdapter` is the lowest-level convenient base class. Subclass it, implement `onMessage(message, tools)`, and you control exactly how the agent reacts. Use this as the starting point when none of the canned adapters (`OpenAIAdapter`, `AnthropicAdapter`, `LangGraphAdapter`, etc.) fit what you're actually building.

This example is a one-step echo, identical in behavior to `basic/` but written as a `SimpleAdapter` subclass instead of a `GenericAdapter` callback. The two are equivalent — pick whichever style you prefer.

## What it shows

- Subclassing `SimpleAdapter`
- Importing `PlatformMessage` and `AdapterToolsProtocol` for fully typed handlers
- Calling `tools.sendMessage` with the required `mentions` array

## Files

| File | What it does |
|------|--------------|
| `custom-adapter.ts` | The whole example — adapter class + agent + CLI runner. |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- `agent_config.yaml`:

```yaml
custom_adapter_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's Thenvoi API key>"
```

## Run

```bash
pnpm --dir packages/sdk exec tsx examples/custom-adapter/custom-adapter.ts
```

## What "working" looks like

1. Process starts, no errors.
2. From a Thenvoi room the agent is in, send: `hello`.
3. The agent replies: `@you Custom adapter received: hello`.

## Where to take it

Replace the `onMessage` body with whatever you want:

```ts
public async onMessage(message: PlatformMessage, tools: AdapterToolsProtocol) {
  // Call your own model / workflow / API
  const reply = await myWorkflow.run(message.content);

  // Stream a "thought" event so the room sees you working
  await tools.sendEvent({ messageType: "thought", content: "Calling workflow..." });

  // Send the final reply
  await tools.sendMessage(reply, [
    { id: message.senderId, handle: message.senderName ?? message.senderType },
  ]);
}
```

Other tools available on `AdapterToolsProtocol`:

- `tools.lookupPeers({ participantType: "Agent" })` — find other agents
- `tools.addParticipant({ participantId })` — invite an agent or user
- `tools.removeParticipant({ participantId })` — eject one
- `tools.getParticipants()` — list current room members
- `tools.createChatroom({ title })` — make a new room

If you want LangChain-style tool calling, multi-turn history management, or MCP server registration, look at the canned adapters (`OpenAIAdapter`, `LangGraphAdapter`, `ClaudeSDKAdapter`) — they all build on `SimpleAdapter` and can serve as templates.
