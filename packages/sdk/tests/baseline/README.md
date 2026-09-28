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
| `BAND_E2E_INCLUDE_PENDING=1` | Also runs adapters marked `pending` (normally N/A), for local use. |
| `RUN_CODEX_ACP_E2E=1` | Opts in to `adapters.codexAcpSmoke`, which needs a local `codex-acp`. |

Each adapter also needs its own model key or CLI (see `requires` in `toolkit/adapters.ts`).

The toolkit's own unit tests, including the `registry.test.ts` drift guard, run in the default
`pnpm test` (Tier 1). The scenarios run only through `test:baseline-live` (Tier 2): the default
config excludes `scenarios/**`.

CI runs the whole suite nightly in `.github/workflows/e2e.yml`'s `baseline` job. A manual
`workflow_dispatch` takes a `filter` (the same vitest arguments) and posts the scorecard as one
sticky comment on the branch's PR, or in the job summary when there is none.

## Layout

| Path | What it is |
| --- | --- |
| `toolkit/registry.ts` | The adapter roster (`ADAPTER_IDS`), scenario categories, and the `specs()` query. |
| `toolkit/adapters.ts` | One `registerAdapter` per adapter: requirements, capabilities, builder, `pending` reason. |
| `toolkit/perAdapter.ts` | `perAdapter` (one test per adapter) and `withAdapters` (one shared room). |
| `toolkit/agents.ts`, `rooms.ts` | Provisioned identities, running agents, rooms and messages; all `await using`. |
| `toolkit/observeMessages.ts` | The reply wait, and the room's stored history. |
| `toolkit/observeDelivery.ts` | The delivery wait. |
| `toolkit/assert*.ts` | Plain assertion functions. |
| `toolkit/scorecard.ts`, `scorecardReporter.ts` | The scorecard's shape and grid, and the vitest reporter that fills it. |
| `scenarios/<category>/*.test.ts` | Scenarios; the category is the first part of the scenario id. |
| `scenarios/samples/` | Shared scenario pieces: markers, the MCP roster flow, approval dialects. |

## Writing a scenario

```ts
perAdapter("platform.repliesToMention", async ({ agent, room }) => {
  await Rooms.sendMention(room, agent, "Reply with the single word: pineapple");
  assertReplyContains(await observeRoom(room).untilReply(agent), "pineapple");
});
```

The id is `<category>.<name>`, and each test is titled `<scenario> > <adapter>`; the scorecard
reads both from the title. `perAdapter` takes `supports` / `without` / `exclude` to narrow the
adapters, `prompt` to steer them, and `build` when a scenario needs an adapter built other than
its registered way (manual approvals, a permission resolver). `withAdapters(ids, …)` puts the
given adapters in one room, in the given order.

The rules:

- **Never hardcode an adapter list.** Select by capability (`supports: ["approvals"]`) and let
  the registry decide; name adapters with `withAdapters` only when the scenario is about those
  particular ones.
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

Add its id to `ADAPTER_IDS` in `toolkit/registry.ts` and register it in `toolkit/adapters.ts`. The
`registry.test.ts` drift guard fails until the roster, the folders under `src/adapters/`, and the
registrations all agree. An adapter CI can't run yet gets a plain-language `pending` reason, and
the scorecard shows it as N/A with that reason.

## Design values

- **Consistency** — one way to do each thing: agents come from `perAdapter` / `withAdapters`,
  waits from the two observers, checks from the assertion functions. Everything fails loudly
  with a reason.
- **Single source of truth** — the roster, a capability, a timeout, a scorecard variable each
  live in one place and are referenced, never re-spelled.
- **Simplicity** — the test is the scenario, not the scaffolding. Provisioning, running, reaping
  and cleanup live in the toolkit, so a body is "send this, expect that". If a test grows
  plumbing, the plumbing belongs in the toolkit.
- **Ease of use** — the common path is the short path: one `perAdapter` call and a few toolkit
  calls, with typed ids instead of magic strings.
