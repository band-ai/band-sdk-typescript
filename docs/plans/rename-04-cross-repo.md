# Thenvoi to Band: cross-repository dependencies

| Field | Value |
|---|---|
| Status | **Reference — not executable in this repository** |
| Decision authority | [Decision plan](rename-00-overview.md) |
| Purpose | Record every rename-adjacent change that lives outside `band-ai/band-sdk-typescript`, so the single-PR scope in D-11 stays honest |

This file exists because the TypeScript SDK rename ships as one pull request
(D-11) in this repository only. Work that must happen in another repository is
listed here with its owner and its relationship to the SDK release. Nothing in
this file is a commit in the rename PR.

Platform behavior recorded here was confirmed with the platform team during review
round 3. The platform is closed source, so this file states only the externally
observable contract the SDK depends on — no internal module names, file paths, or
implementation detail. Where a claim is unconfirmed, it says so.

## Owners in play

| Owner | Role |
|---|---|
| `band-ai/band-sdk-typescript` | This repo. Owns the rename PR and the 1.0.0 release. |
| Platform team (closed source) | Owns the API, the OpenAPI source of truth, host routing, and the pagination contract. |
| `@band-ai/rest-client` generator/publisher | Owns the generated REST client the SDK depends on. Regenerating it requires a local platform instance, so it is platform-side work. |
| Python SDK repository | Separate rename with its own tool-name mismatch. |
| npm organization `band-ai` | Trusted-publisher configuration. Not a repository. |

## X-01 — platform host routing: no change required

**Owner:** platform · **Blocks:** nothing · **Status:** verified, closed

The platform contract the SDK relies on, confirmed with the platform team:

- browser traffic on the legacy `thenvoi.com` hosts is redirected to `band.ai`;
- **API requests and WebSocket upgrades on the legacy hosts are not redirected and
  continue to be served**, deliberately, because published SDKs carry the legacy
  host as their default and WebSocket clients do not follow redirects during the
  handshake;
- both `thenvoi.com` and `band.ai` origins are accepted for the socket;
- the socket path is `/api/v1/socket` on both hosts, matching the SDK and OpenClaw
  defaults.

Consequence for the SDK: R-10's default-host change is a convenience, not a
cutover. Consumers who pin the old host with an explicit `wsUrl`/`restUrl` keep
working. This is what closes O-04.

Do not remove the `*.thenvoi.com` API/WS pass-through until published SDKs
carrying the legacy default are out of support. That retirement is a platform
decision with an SDK-version precondition, not part of this rename.

## X-02 — `@band-ai/rest-client` generator and publishing hardening

**Owner:** unassigned · **Blocks:** nothing in the rename PR · **Status:** open

The SDK's C2 commit pins `@band-ai/rest-client@0.0.118`. One item sits upstream of
that pin:

- **Broken exact version.** `@band-ai/rest-client@0.0.113` is recorded as broken in
  the decision plan's exclusions and must be deprecated. Only that exact version —
  never the unversioned package, whose latest is healthy.

Regeneration is platform-side work: it requires running a local platform instance,
so it cannot be done from this repository.

Two notes for whoever picks this up. The published `0.0.118` declares
`BandEnvironment.Default = "https://app.band.ai"`, which agrees with R-10 and with
OpenClaw's defaults — the SDK does not consume it (it always passes an explicit
base URL), but it should stay correct for anyone who does. And the generated
surface changed between `0.0.113` and `0.0.118`; see C2 in the delivery spec for
the full list of renamed and removed symbols.

## X-03 — cursor pagination before the 2026-10-01 sunset

**Owner:** O-03, engineering owner for cursor pagination · **Blocks:** REL-01 ·
**Status:** open, separate implementation plan

The server sunsets the SDK's current pagination path on 2026-10-01. The decision
plan gates REL-01 on this: do not publish a 1.0 whose supported pagination path
has a known server sunset. This is the only cross-repository item that blocks the
release, and it is not part of the rename PR.

## X-04 — observability event rebrand

**Owner:** observability rebrand · **Blocks:** nothing · **Status:** excluded by
the decision plan

The 82 `linear_thenvoi_bridge.*` event names emitted by this SDK are deliberately
retained by the rename (they are dashboard and alert keys). Renaming them requires
coordinated changes to whatever consumes them, which lives outside this
repository. `P-TOOL-08` lists them as permitted legacy hits so the completeness
scan does not fail on them.

## X-05 — Python SDK rename and tool-name mismatch

**Owner:** unassigned · **Blocks:** nothing in this repo · **Status:** open

The Python SDK has its own Thenvoi→Band rename. It matters here for one reason:
after this SDK's C7 commit, the TypeScript SDK advertises `band_*` tools and
`mcp__band__`, while an unrenamed Python SDK still advertises `thenvoi_*`. Agents
built on both would present two differently-named tool sets for the same
capabilities.

That is a coordination cost, not a correctness break in either SDK. Record the
skew in the 1.0.0 release notes so users of both are not surprised.

## X-06 — GitHub organization consolidation

**Owner:** unassigned · **Blocks:** nothing · **Status:** excluded

The repository already lives at `band-ai/band-sdk-typescript` (confirmed via
`git remote`). Remaining organization consolidation is tracked separately and has
no effect on the rename or the release.

## X-07 — npm trusted-publisher configuration

**Owner:** O-01, npm organization owner · **Blocks:** PREFLIGHT, therefore the
entire rename PR · **Status:** open

Not a repository change, but the hardest external precondition. Both
`@band-ai/sdk` and `@band-ai/openclaw-channel-band` need trusted-publisher entries
matching `band-ai/band-sdk-typescript` and `release.yml`. The manifest records SDK
`0.1.7` while npm latest is `0.1.6`, which is the evidence that the current SDK
OIDC path has not published successfully.

PREFLIGHT cannot be satisfied without this, and PREFLIGHT must pass before the
rename PR is opened for merge.

## Ordering summary

```text
X-07 (npm trusted publisher)  ──> PREFLIGHT ──> rename PR (C1..C7) ──> REL-01
X-03 (cursor pagination)      ─────────────────────────────────────────^
X-01  closed, no action
X-02, X-04, X-05, X-06        parallel, gate nothing
```
