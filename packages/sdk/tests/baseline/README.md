# Baseline E2E

Live scenarios against the real Band platform, fanned out across every framework
adapter from one registry, with a scenario × adapter scorecard. The TypeScript
counterpart of band-sdk-python's `tests/e2e/baseline`.

## Running

```bash
# From packages/sdk, with the repo's .env.test populated (already-set variables win).
pnpm run test:baseline-live                                    # the whole suite
pnpm run test:baseline-live -t anthropic                       # one adapter, every scenario
pnpm run test:baseline-live -t repliesToMention                # one scenario, every adapter
pnpm run test:baseline-live tests/baseline/scenarios/behavior  # one category
```

Scope with vitest's own `-t` or a path, with no `--` (it breaks `-t` filtering).

| Variable | Effect |
| --- | --- |
| `BAND_API_KEY_USER` | The Band user key every run provisions and reaps its agents with. Required. |
| `BAND_E2E_SCORECARD_JSON` | Writes the scorecard to this path, plus a `.md` grid beside it. |
| `BAND_E2E_INCLUDE_PENDING=1` | Fans `perAdapter` scenarios out to adapters marked `pending` too (they are omitted by default). |
| `BAND_E2E_DEBUG_LOGS=1` | Prints the SDK's own logs from every running agent and each room's observer, each line stamped with wall-clock time and its source. Off by default: without it the SDK's logs are dropped. |
| `RUN_CODEX_ACP_E2E=1` | Includes `adapters.codexAcpSmoke` in the baseline run (needs a local `codex-acp`); excluded from `vitest.baseline.config.ts` when unset. |

Each adapter also needs its own model key or CLI (see `requires` in `toolkit/adapters.ts`). letta and
parlant need a running server: CI starts them with `.github/scripts/setup-letta.sh` (docker) and
`setup-parlant.sh`, which pin the image and version. Locally, start one the same way and export
`LETTA_BASE_URL` / `PARLANT_ENVIRONMENT`.

The toolkit's own unit tests, including the `registry.test.ts` drift guard, run in the default
`pnpm test` (Tier 1). The scenarios run only through `test:baseline-live` (Tier 2): the default
config excludes `scenarios/**`.

CI runs the whole suite nightly in `.github/workflows/e2e.yml`'s `baseline` job. A manual
`workflow_dispatch` takes a `filter` (the same vitest arguments) and posts the scorecard as one
sticky comment on the branch's PR, or in the job summary when there is none.

## Layout

| Path | What it is |
| --- | --- |
| `toolkit/adapters.ts` | The roster: one spec per adapter (requirements, capabilities, builder, `pending` reason). `ADAPTER`, `ADAPTER_IDS`, `AdapterId` and `specs()` are derived from it. |
| `toolkit/registry.ts` | The registry's vocabulary and mechanics: `requires`, `CAPABILITY`, `CATEGORY` / `scenarioId`, and spec filtering. |
| `toolkit/perAdapter.ts` | `perAdapter` (one test per adapter) and `withAdapters` (one shared room). |
| `toolkit/agents.ts`, `rooms.ts` | Provisioned identities, running agents, rooms and messages; all `await using`. |
| `toolkit/observeMessages.ts` | The reply wait, and the room's stored history. |
| `toolkit/observeDelivery.ts` | The delivery wait, a message's current `status()`, and the `history()` of statuses it passed through. A wait that times out also reads the room back over REST and returns what the platform stored as `stalled`, so a missing update can be told from a missed frame. |
| `toolkit/debugLogger.ts` | The SDK `Logger` behind `BAND_E2E_DEBUG_LOGS`; `Agents.runAs` and `Rooms.create` pass it on. |
| `toolkit/droppableTransport.ts` | An agent transport whose live socket a scenario can drop, as a network failure would. |
| `toolkit/assert*.ts` | Plain assertion functions. |
| `toolkit/scorecard.ts`, `scorecardReporter.ts` | The scorecard's shape and grid, and the vitest reporter that fills it. |
| `scenarios/<category>/*.test.ts` | Scenarios; the category is the first part of the scenario id. |
| `scenarios/samples/` | Shared scenario pieces: markers, the MCP roster flow, approval dialects, opaque lookup and forecast tools, the exact-tools prompt, the memory and event samples, and `takeTurn` (say it, wait until processed). |

## Writing a scenario

```ts
const REPLY_WORD = "pineapple";

perAdapter(scenarioId(CATEGORY.platform, "repliesToMention"), async ({ agent, room }) => {
  await Rooms.sendMention(room, agent, `Reply with the single word: ${REPLY_WORD}`);
  assertReplyContains(await observeRoom(room).untilReply(agent), REPLY_WORD);
});
```

The id is `<category>.<name>`, built with `scenarioId`, and each test is titled
`<scenario> > <adapter>`; the scorecard reads both from the title. `perAdapter` takes `supports` / `without` / `exclude` to narrow the
adapters, `prompt` to steer them, and `build` when a scenario needs an adapter built other than
its registered way (manual approvals, a permission resolver, custom tools for adapters that support
`CAPABILITY.customTools`, memory tools for those that support `CAPABILITY.memory`). `withAdapters(ids, …)` puts the
given adapters in one room, in the given order.

The rules:

- **Never hardcode an adapter list.** Select by capability (`supports: [CAPABILITY.approvals]`)
  and let the registry decide; name adapters with `withAdapters([ADAPTER.codex], …)` only when
  the scenario is about those particular ones.
- **No magic strings or numbers.** Each vocabulary is defined once and referenced:
  `DELIVERY_STATUS`, `REPLY_WAIT`, `MESSAGE_TYPE` (the platform's own), `SCORECARD_STATUS`,
  `ADAPTER`, `CAPABILITY`, `CATEGORY`. Where the SDK or a library already defines a value, use
  theirs; where it only defines a type, name the value once with `satisfies` against that type.
- **Fail loudly, never skip.** A missing key, package or CLI fails the test with its reason. The
  only skips are an adapter's `pending` reason (shown as N/A) and an explicit opt-in flag.
- **Two waits, never confused:**
  - `observeRoom(room).untilReply(agent)` waits for the agent's reply. Assert on reply text only
    after this.
  - `observeAgent(agent, room).untilProcessed(sent)` waits for the platform's delivery state:
    the turn has finished and its durable state (events, tool calls) is saved. Read `history()`
    only after this.

  A reply frame and the processed frame are unordered platform events, so neither wait implies
  the other.
- **Release everything with `await using`.** Teardown logs failures and never throws.
- **Assert structure, not prose.** Agents are non-deterministic: assert a marker, a substring, a
  delivery state or a metadata fact.
- **Reuse before adding.** A helper used by more than one scenario goes in `toolkit/` or
  `scenarios/samples/`, not inline.

## Adding an adapter

Add its spec to `SPECS` in `toolkit/adapters.ts`, with `id` set to its directory under
`src/adapters/`; its `ADAPTER` handle and everything else follow from that. The `registry.test.ts`
drift guard fails until the roster and the folders under `src/adapters/` agree. An adapter CI can't run yet gets a plain-language `pending` reason and is
left out of `perAdapter` fan-out until `BAND_E2E_INCLUDE_PENDING=1`. `withAdapters` scenarios that name only a pending adapter still record N/A via a vitest skip on that row.
An adapter the generic scenarios don't fit (Parlant has no Band tools) gets a `bespokeOnly` reason instead: it runs only in the `adapters.*` scenarios that name it, and
`perAdapter` fan-outs show it as N/A with that reason.

## Planned scenarios (not in the tree yet)

Add these as real scenarios when the SDK or platform exposes what they need — no placeholder `it()` blocks that only throw or skip.

| Id | Blocked on |
| --- | --- |
| `inspection.usage` | Per-turn token usage reported by the SDK (band-sdk-python usage smokes). |
| `behavior.controlSignals` | User stop/play/interrupt on the platform and handling in the TS runtime (Python `test_next_actionable_semantics`). |

## Design values

- **Consistency** — one way to do each thing: agents come from `perAdapter` / `withAdapters`,
  waits from the two observers, checks from the assertion functions. Everything fails loudly
  with a reason.
- **Single source of truth** — the roster, a capability, a status, a timeout, a scorecard
  variable each live in one place and are referenced, never re-spelled.
- **Simplicity** — the test is the scenario, not the scaffolding. Provisioning, running, reaping
  and cleanup live in the toolkit, so a body is "send this, expect that". If a test grows
  plumbing, the plumbing belongs in the toolkit.
- **Ease of use** — the common path is the short path: one `perAdapter` call and a few toolkit
  calls, with typed ids instead of magic strings.
