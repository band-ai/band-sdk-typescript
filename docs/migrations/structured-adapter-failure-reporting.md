# Structured adapter failure reporting

`@band-ai/sdk` reports a failed turn through structured `AgentFailure` events.
Three compile-time breaks land together: nested A2A gateway failure metadata, a
required `SimpleAdapter.provider`, and a required `MessagingTools.sendFailure`.
Custom adapters should import the public helpers below instead of copying the
old throw-and-hope pattern.

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
import type { HistoryProvider } from "@band-ai/sdk";

export abstract class MyAdapter extends SimpleAdapter<HistoryProvider> {
  protected readonly provider = "my-adapter";
}
```

Omitting it is a TypeScript error.

## 3. Required `MessagingTools.sendFailure`

`MessagingTools` now requires `sendFailure(failure: AgentFailure)`. A custom
`MessagingTools` / adapter tools object that only implemented `sendMessage` /
`sendEvent` no longer type-checks.

Keep generate/provider work in `try`. Guard `RecoverableTurnError` so a delivery
failure is never reclassified. Call `deliverReply` after the catch so it cannot
be mistaken for a provider fault.

```ts
import {
  SimpleAdapter,
  deliverReply,
  RecoverableTurnError,
  reportTurnFailure,
  agentFailure,
} from "@band-ai/sdk";
import type {
  HistoryProvider,
  PlatformMessage,
  AdapterToolsProtocol,
} from "@band-ai/sdk";

type GenerateFn = (prompt: string) => Promise<string>;

export class MyAdapter extends SimpleAdapter<HistoryProvider> {
  protected readonly provider = "my-adapter";

  public constructor(private readonly generate: GenerateFn) {
    super();
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
  ): Promise<void> {
    let text: string;
    try {
      text = await this.generate(message.content);
    } catch (error) {
      if (error instanceof RecoverableTurnError) {
        throw error;
      }
      await reportTurnFailure(
        tools,
        agentFailure(this.provider, error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    await deliverReply(tools, text);
  }
}
```

`reportTurnFailure` posts via `sendFailure` and throws `ProviderTurnFailedError`
so `PlatformRuntime` marks the message failed without taking the room down.
`agentFailure` is the safe `AgentFailure` constructor (drops unserializable
`detail` instead of throwing on the failure path).

## 4. A2A terminal states fail the inbound turn

A2A terminal task states `failed`, `canceled`, `rejected`, and `auth-required`
now fail the inbound Band turn (retryable, structured `AgentFailure`) instead of
resolving the turn as a successful no-op. Platform resync or retry may replay
the same inbound. Remote A2A handling must be idempotent for those states.

## 5. CJS import consistency

ESM `import` of helpers from `@band-ai/sdk` and `@band-ai/sdk/core` shares one
module instance. CJS `require()` of those two entries loads duplicated class
identities (tsup emits a copy per entry). Mixing them makes `instanceof
DeliveryFailedError` miss and can reclassify a delivery failure as a provider
fault.

CJS callers must import the helper/error pair — and any runtime error class used
for `instanceof` — from **one** entrypoint consistently (`require("@band-ai/sdk")`
or `require("@band-ai/sdk/core")`, not both).
