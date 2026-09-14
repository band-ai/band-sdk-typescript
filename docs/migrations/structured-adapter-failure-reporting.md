# Structured adapter failure reporting

This PR changes how adapters report a failed turn. Three compile-time breaks
land together: nested A2A gateway failure metadata, a required
`SimpleAdapter.provider`, and a required `MessagingTools.sendFailure`. Custom
adapters should import the public helpers below instead of copying the old
throw-and-hope pattern.

## 1. A2A gateway `metadata.failure`

A2A gateway failure metadata is nested under `metadata.failure` and uses
`provider`, `code`, `message`, and `detail`.

Consumers that read the former flat `error_type` or `error_message` keys must
switch to `event.metadata.failure`.

```ts
const failure = event.metadata?.failure as
  | { provider?: string; code?: string; message?: string; detail?: unknown }
  | undefined;
```

## 2. Required `SimpleAdapter.provider`

Every `SimpleAdapter` subclass must declare a `provider` identity. That string
is `AgentFailure.provider` on every structured failure the adapter reports.

```ts
import { SimpleAdapter } from "@band-ai/sdk";

export class MyAdapter extends SimpleAdapter<HistoryProvider> {
  protected readonly provider = "my-adapter";
  // ...
}
```

Omitting it is a TypeScript error.

## 3. Required `MessagingTools.sendFailure`

`MessagingTools` now requires `sendFailure(failure: AgentFailure)`. A custom
`MessagingTools` / adapter tools object that only implemented `sendMessage` /
`sendEvent` no longer type-checks.

Use the public helpers so a rejected `sendMessage` stays a recoverable delivery
failure, and a provider error posts exactly one `AgentFailure` then fails the
turn:

```ts
import {
  SimpleAdapter,
  deliverReply,
  DeliveryFailedError,
  reportTurnFailure,
  ProviderTurnFailedError,
  agentFailure,
} from "@band-ai/sdk";
// equivalent: import { ... } from "@band-ai/sdk/core";

export class MyAdapter extends SimpleAdapter<HistoryProvider> {
  protected readonly provider = "my-adapter";

  public async onMessage(message, tools) {
    try {
      await deliverReply(tools, "hello");
    } catch (error) {
      if (error instanceof DeliveryFailedError) {
        throw error; // recoverable Band-side post failure, not a provider fault
      }
      await reportTurnFailure(
        tools,
        agentFailure(this.provider, error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
```

`reportTurnFailure` posts via `sendFailure` and throws `ProviderTurnFailedError`
so `PlatformRuntime` marks the message failed without taking the room down.
`agentFailure` is the safe `AgentFailure` constructor (drops unserializable
`detail` instead of throwing on the failure path).
