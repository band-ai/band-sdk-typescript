# A2A gateway failure metadata (breaking)

## What changed

`A2AGatewayAdapter`'s `status-update` events for a failed execution now carry
their `AgentFailure` nested under `metadata.failure`, matching the
`metadata.failure` convention every room-level `sendFailure` already uses
elsewhere in this SDK — instead of a flat, gateway-only shape with its own
key names.

| Before | After |
|---|---|
| `metadata.error_type` | `metadata.failure.code` |
| `metadata.error_message` | `metadata.failure.message` |
| — | `metadata.failure.provider` (always `"a2a-gateway"`) |
| — | `metadata.failure.detail` (currently always `null` on this path) |

## Who is affected

Any remote A2A client reading `metadata.error_type` / `metadata.error_message`
directly off a `status-update` event's metadata. No type error reaches such a
client — the old keys are simply absent from the new payload. No inventory of
external A2A clients has been taken; if you operate one, update it to read
`metadata.failure.code` / `metadata.failure.message` instead.

## Where this is emitted

Every A2A gateway failure path builds this metadata through
`buildGatewayFailureMetadata` (`src/adapters/a2a-gateway/server.ts`):
peer-not-found, room-post failures, response timeouts, and relayed room-level
`error` events (via `sanitizeForwardedFailure`, which independently
re-redacts the message and drops `detail` rather than forwarding a room
failure's raw payload).
