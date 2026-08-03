# Thenvoi to Band: delivery and proof specification

| Field | Value |
|---|---|
| Status | **APPROVED at round 3 — executable as one PR after PREFLIGHT and O-01** |
| Decision authority | [Decision plan](rename-00-overview.md) |
| Specialized specifications | [Storage compatibility](rename-02-storage-compatibility-spec.md) · [Tool and MCP rename](rename-03-tool-mcp-spec.md) · [Cross-repository dependencies](rename-04-cross-repo.md) |

This file defines executable units and proof. It does not redefine compatibility
or scope decisions from the decision plan.

## Required gate after every commit

Run from the repository root:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Record each command's exit status and per-package test counts. Also run each
unit's focused proof. A package filter that executes zero tests is a failure.

All seven units below are **ordered commits inside one pull request** (D-11), not
separate PRs. Every commit must leave the tree green on its own so the per-commit
proof matrix stays meaningful and `git bisect` remains usable; do not squash on
merge. PREFLIGHT is a release operation that runs on unmodified `main` **before**
the PR opens.

## C1 — restore truthful CI and harden the publish path

Outcome:

- replace all stale OpenClaw package filters with
  `@band-ai/openclaw-channel-band`;
- add `--fail-if-no-match` before every CI `--filter` invocation;
- add one checked-in release-guard command that exits non-zero when the hold
  marker exists;
- invoke that exact command immediately before each real `npm publish`;
- add pre-publish package-content assertions for required entries and a reviewed
  file-count floor, evaluated **after** the `cp README.md packages/sdk/README.md`
  step (`release.yml:71`) so the assertion sees the bytes that are actually
  published; `README.md` is a required packed entry;
- move the root `pnpm.overrides` block into `pnpm-workspace.yaml`, which pnpm 10
  reads, and fail CI on the ignored-`pnpm`-field warning;
- add the release-hold marker in this same commit, so the branch is never
  publishable from the moment it carries a break.

Boundary: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, one guard
script, root `package.json`/`pnpm-workspace.yaml` override migration, and focused
workflow tests/static workflow assertions.

Known local/CI delta: `packages/sdk/README.md` is not checked in, so a local
`npm pack` omits it. Any local packing proof must either copy the README first or
record the omission explicitly; it must not assert a file-count floor that only
holds locally.

Failure behavior: when the marker is later present, the release job may still
create/update a release-please PR, but no package bytes may be published. A
missing filter or invalid package content must fail instead of warning/succeeding.

Proof:

| ID | Old failure and executable proof | Expected | Status |
|---|---|---|---|
| P-C1-1 | Run `pnpm --fail-if-no-match --filter definitely-no-such-package exec node -e ""`. | Exit non-zero. | **Pass at research time** |
| P-C1-2 | Run the exact SDK and OpenClaw filters used by CI with a command printing a sentinel. | Both print the sentinel once. | Planned |
| P-C1-3 | Execute the real guard with and without the marker; statically assert both workflow publish steps call that command immediately before `npm publish`. | Marker fails; absence passes; neither publish step can bypass the shared command. | Planned |
| P-C1-4 | Run both package test suites. | Non-zero tests, no failures. | **Pass at research time**: SDK 696 tests / 88 files, OpenClaw 156 tests / 9 files, both green; typecheck and lint exit zero. These are the I-06 baselines. |
| P-C1-5 | Run `pnpm install` and inspect the installed tree for each declared override. | No ignored-`pnpm`-field warning; every override resolves to its required version. | Planned |

Handoff: PREFLIGHT below must already have passed before this commit is written,
because it cannot be run from a tree carrying the hold marker or the rename.

## PREFLIGHT — prove current trusted publishing before the rename PR

This runs on current `main`, before the rename PR is opened. An npm organization
owner confirms both trusted-publisher entries against
`band-ai/band-sdk-typescript` and `release.yml`. Prepare one nonbreaking patch
release that exercises both package-specific publish branches. Install-check both
outputs and verify provenance and required packed entries.

It cannot be folded into the PR: proving the publish path requires actually
publishing, and the PR's first commit installs a hold that forbids exactly that.
This is the one piece of sequencing the single-PR shape cannot absorb.

Mechanism. `release.yml` gates each publish step on that package's own
`packages/<pkg>--release_created` output, so a preflight that exercises both
branches requires release-please to cut a release for **both** packages in one
run. Land one `fix:` commit that touches a file inside `packages/sdk` and a second
`fix:` commit that touches a file inside `packages/openclaw`. `release-please-config.json`
sets `bump-patch-for-minor-pre-major: true` for both packages, so a `fix:` yields a
patch bump pre-1.0, and the config declares no `separate-pull-requests`, so both
bumps arrive in one release PR. Confirm the resulting release-please
PR bumps both manifest entries before merging it; a PR that bumps only one package
has not proven the other publish branch and must not be accepted as P-PRE-1.

Version note. The manifest records `packages/sdk: 0.1.7` while npm latest is
0.1.6, so the preflight patch publishes **0.1.8**. Version 0.1.7 keeps its git tag
and is never published. This is expected and consistent with D-07; do not attempt
to publish 0.1.7 or move the manifest backward to reconcile the gap.

If either publish path fails, fix it while no release hold or breaking rename is
present and repeat with a new immutable patch version. The rename PR must not be
opened for merge until this proof passes.

| ID | Proof | Expected | Status |
|---|---|---|---|
| P-PRE-1 | Patch release of both packages under current OIDC on unmodified `main`. | Both versions advance, install, carry provenance, and include required files. | Blocked on npm owner (O-01) |

## C2 — swap the generated REST-client package scope

Outcome: SDK source and lockfile use `@band-ai/rest-client@0.0.118`, with no
operation this SDK consumes removed or altered. This commit introduces no public
SDK break and is independent of the naming work in C3 onward.

The generated surface does change between `@thenvoi/rest-client@0.0.113` and
`@band-ai/rest-client@0.0.118`, so "scope swap" understates the unit:

- root exports renamed: `ThenvoiClient`→`BandClient`, `ThenvoiError`→`BandError`,
  `ThenvoiTimeoutError`→`BandTimeoutError`, namespace `Thenvoi`→`Band`,
  `ThenvoiEnvironment`→`BandEnvironment`;
- resources `system` and `test` removed; `agentApiActivity` added;
- types `Memory`/`MemoryCreateRequest` renamed to
  `AgentMemory`/`AgentMemoryCreateRequest`; `HealthCheck`/`TestResponse` removed.

At the research commit the SDK touches this dependency at exactly one site
(`platform/ThenvoiLink.ts:35` and `:122`, importing `ThenvoiClient`) and uses none
of the removed resources or types, so the change is internal. `FernThenvoiClientLike`
is defined structurally by the SDK, not imported from the generated package, so it
stays with C5. If a future base introduces a use of a removed resource, P-C2-1
is the proof that catches it — **not** P-C2-2, which runs against a structural fake
and cannot observe a removed generated resource.

Boundary: SDK package metadata, lockfile, generated-client imports/types, and a
Fern adapter conformance test. Do not take 0.0.119 or later in this unit.

Proof:

| ID | Proof | Expected | Status |
|---|---|---|---|
| P-C2-1 | Typecheck and run the SDK suite after the exact dependency swap. | No TypeScript errors; baseline tests pass. | Planned; previously probed, must rerun on implementation base |
| P-C2-2 | Invoke every REST operation the adapter claims to support against a structural fake. | No operation rejects with `UnsupportedFeatureError`; zero network calls. | Planned |
| P-C2-3 | Inspect the packed SDK dependency graph. | No runtime dependency on `@thenvoi/rest-client`; exactly 0.0.118 selected. | Planned |

## C3 — Linear names, examples, and configuration compatibility

Outcome:

- rename the two exported `LinearThenvoi*` types and example/test-only symbols;
- rename the example directory and scripts coherently;
- use `linear_band_bridge`/`linear_band_transport` and `LINEAR_BAND_*` names;
- accept the old YAML key with a one-time warning in every documented example
  entry path;
- read every renamed Linear env setting Band-first with per-field
  `LINEAR_THENVOI_*` fallback and once-per-variable warnings;
- retain `.linear-thenvoi-example.sqlite` as the compatibility default;
- remove the dead recovered-room env test knob rather than renaming it;
- leave `linear_thenvoi_bridge.*` observability event names untouched.

Boundary: Linear integration barrels/types, examples, tests,
package scripts, and all documentation links to the renamed example path. The
private SQLite names remain unchanged; public `thenvoiRoomId` fields belong to
C4.

Proof:

| ID | Proof | Expected | Status |
|---|---|---|---|
| P-C3-1 | Compile ESM and CJS consumers importing the new exported names, and compile a fixture using old names. | New succeeds; old fails at compile time. | Planned |
| P-C3-2 | Start each example config entry path with only `linear_thenvoi_bridge`. | Starts and warns once; no silent miss. | Planned |
| P-C3-3 | Open an existing default-path fixture and run one dispatch. | Existing binding is reused; no second room is requested. | Planned |
| P-C3-3B | Configure a non-default live DB only through `LINEAR_THENVOI_STATE_DB`, plus table-driven old-only/mixed/both cases for every renamed Linear env setting. | Exact custom path is reused; Band wins per field; warnings are once per legacy field; no empty default DB is opened. | Planned |
| P-C3-4 | Search scoped source, examples, scripts, tests, and docs with explicit exclusions for DB schema, metadata, and log events owned elsewhere. | No unowned Linear naming hit; every exclusion maps to a later unit or explicit exclusion. | Planned |

The release-hold marker is added by C1, so it is already present here. CI/proof
must demonstrate that the merged tree containing renamed exports cannot publish
either package.

## C4 — public room-id fields, outbound metadata, adapter identity; retain storage schema

Outcome: execute the linked storage compatibility specification; rename
`thenvoiRoomId` to `bandRoomId` in public Linear contracts without aliases while
mapping retained `thenvoi_room_id` rows at the store boundary; rename the six
outbound metadata keys and three brand values as an atomic payload change.

Also rename the six adapter identity strings required by R-12 and D-08:

| Site | Old | 1.0 |
|---|---|---|
| `adapters/codex/CodexAdapter.ts:158,463` | `clientName: "thenvoi_codex_adapter"` | `"band_codex_adapter"` |
| `adapters/codex/CodexAdapter.ts:159,464` | `clientTitle: "Thenvoi Codex Adapter"` | `"Band Codex Adapter"` |
| `adapters/google-adk/GoogleADKAdapter.ts:22` | `APP_NAME = "thenvoi"` | `"band"` |
| `adapters/google-adk/GoogleADKAdapter.ts:308` | default agent name `"thenvoi_agent"` | `"band_agent"` |
| `adapters/a2a-gateway/server.ts:406` | skill `tags: ["thenvoi", "gateway"]` | `["band", "gateway"]` |
| `adapters/opencode/OpencodeAdapter.ts:138` | `sessionTitlePrefix: "Thenvoi"` | `"Band"` |

All are write-only identity: Codex `clientInfo` is sent once in `initialize`, the
A2A tag is published discovery metadata, the OpenCode prefix only formats new
session titles (`:986`), and `GoogleADKAdapter` passes `APP_NAME` only to
`createRunner` and `createSession` alongside a fresh `randomUUID()` session id
(`:239-247`) with no resume or `getSession` path. Renaming therefore abandons no
state this SDK later reads back. The Codex fields and the OpenCode prefix all
remain caller-overridable.

Note that OpenCode's neighbouring `mcpServerName: "thenvoi"` (`:139`) is **not**
part of this unit — it is an MCP server name owned by C7's `MCP_SERVER_NAME`
constant. Rename the prefix here and leave the server name to C7.

Boundary: Linear store mapping/types/callers, A2A gateway outbound metadata and
agent-card skill tags, Parlant metadata and session title (`ParlantAdapter.ts:287`),
Linear bridge brand metadata, Codex/Google ADK/OpenCode adapter identity strings,
tests, and changelog input. Do not rename physical SQLite identifiers, `gateway_*`,
`a2a_*`, API paths, observability events, or any MCP server name.

Proof:

| ID | Proof | Expected | Status |
|---|---|---|---|
| P-C4-1 | Run the complete no-DDL matrix in the linked spec. | Existing and fresh stores keep the identical legacy physical schema while exposing Band public fields. | Planned |
| P-C4-2 | Compile external fixtures against old/new public room-id field names. | Band succeeds; Thenvoi fails. | Planned |
| P-C4-3 | Snapshot each outbound payload owner. | Exact Band key/value set; no mixed namespace. | Planned |
| P-C4-4 | Re-run message-history/routing tests. | Routing still reads unchanged `gateway_*`/`a2a_*` keys. | Planned |
| P-C4-5 | Assert the Codex `clientInfo` sent at `initialize`, the generated A2A agent card, and the ADK runner/session/agent names; then scan every outbound path for a reachable `thenvoi` brand string. | Exact Band values at all five sites; caller `options.config` overrides still win for Codex; no unowned outbound `thenvoi` hit remains. | Planned |

## C5 — package identity and remaining public symbols

Outcome:

- source package identity becomes `@band-ai/sdk`;
- remove the publish-time `sed` rewrite;
- update workspace filters, imports, exports, package repository metadata, and
  all remaining public `Thenvoi*` identifiers, including the scope previously
  assigned to INT-404;
- retain the release hold.

Boundary: package metadata, barrels, adapter/core/MCP/ACP type names, consumers,
tests, examples, CI/release filters, and documentation. Tool names, MCP prefix,
env vars, URL defaults, and metadata are owned by other units.

Authoritative public migration map at the research commit:

| Old export | 1.0 export |
|---|---|
| `ThenvoiLink` | `BandLink` |
| `LinearThenvoiBridgeConfig` | `LinearBandBridgeConfig` |
| `LinearThenvoiBridgeDeps` | `LinearBandBridgeDeps` |
| `ThenvoiACPServerAdapter` | `BandACPServerAdapter` |
| `ThenvoiACPServerAdapterOptions` | `BandACPServerAdapterOptions` |
| `ThenvoiMcpBackend` | `BandMcpBackend` |
| `ThenvoiMcpBackendKind` | `BandMcpBackendKind` |
| `CreateThenvoiMcpBackendOptions` | `CreateBandMcpBackendOptions` |
| `createThenvoiMcpBackend` | `createBandMcpBackend` |
| `getThenvoiSdkMcpServerConfig` | `getBandSdkMcpServerConfig` |
| `ThenvoiMcpServer` | `BandMcpServer` |
| `ThenvoiMcpServerOptions` | `BandMcpServerOptions` |
| `ThenvoiMcpSseServer` | `BandMcpSseServer` |
| `ThenvoiMcpSseServerOptions` | `BandMcpSseServerOptions` |
| `ThenvoiMcpStdioServer` | `BandMcpStdioServer` |
| `ThenvoiMcpStdioServerOptions` | `BandMcpStdioServerOptions` |
| `ThenvoiSdkMcpServer` | `BandSdkMcpServer` |
| `CreateThenvoiSdkMcpServerOptions` | `CreateBandSdkMcpServerOptions` |
| `createThenvoiSdkMcpServer` | `createBandSdkMcpServer` |
| `ThenvoiSdkError` | `BandSdkError` |
| `FernThenvoiClientLike` | `FernBandClientLike` |

C3 establishes the two Linear rows; C5 owns the remainder and the final
audit. Generate a machine-readable before/after inventory from every declared
package export's built ESM keys and `.d.ts` named exports. Review any additional
`Thenvoi` export found against this table: add a replacement or an explicit
removal disposition before merge. The same artifact generates the 1.0 migration
section so release notes cannot drift from the package surface.

Proof:

| ID | Proof | Expected | Status |
|---|---|---|---|
| P-C5-1 | Build and pack without mutation, then import every export subpath under ESM and CJS with optional peers as required. | Packed name is `@band-ai/sdk`; all intended exports resolve. | Planned |
| P-C5-2 | Compare generated before/after runtime and declaration export inventories with the authoritative mapping; compile one consumer fixture per mapped export. | Every removed public export has exactly one replacement/removal disposition; every replacement resolves; old names fail. | Planned |
| P-C5-3 | Inspect release workflow. | No `sed` or equivalent package mutation; hold still blocks publication. | Planned |

## C6 — environment configuration, URLs, and documentation

Outcome across both shipped packages and the operational E2E harness:

- default env prefix becomes `BAND_` with per-field legacy fallback;
- a custom prefix remains exact, including an explicitly empty prefix;
- Band wins independently for `AGENT_ID`, `API_KEY`, `WS_URL`, and `REST_URL`;
- warnings identify each legacy variable and replacement once per process;
- OpenClaw's account-field precedence remains above env values, but its legacy
  env fallback now emits the same once-per-variable warnings;
- OpenClaw E2E reads `BAND_API_KEY_USER` first and falls back to the E2E-only
  legacy `THENVOI_API_KEY_USER`, alongside Band-first credential/URL fields;
- default service URLs and user-facing docs use `app.band.ai`, aligning the SDK
  with OpenClaw's existing defaults and with `BandEnvironment.Default` in
  `@band-ai/rest-client@0.0.118`;
- explicit caller URLs remain untouched.

Default-host change (R-13, C-06, D-10). `platform/ThenvoiLink.ts:49` currently
defaults to `wss://app.thenvoi.com/api/v1/socket`, and `:112` derives the REST URL
from it via `deriveDefaultRestUrl`, so changing the WS default moves both. Also
update `integrations/linear/bridge/handler.ts:37`
(`DEFAULT_THENVOI_APP_BASE_URL`), which builds user-visible Linear deep links.

This retargets any consumer that never passed an explicit URL, with no compile
error and no warning, so it must lead the release notes. Per O-04 it is not a hard
cutover: platform routing redirects only browser traffic off the legacy host and
continues to serve API requests and WebSocket upgrades on `app.thenvoi.com`,
specifically because published SDKs carry that host as their default. Pinning the
old host by passing an explicit `wsUrl`/`restUrl` therefore remains a valid escape
hatch, and the release notes must say so.

Boundary: SDK config loader/types/tests, OpenClaw `src/config.ts` and unit tests,
OpenClaw E2E setup, both packages' defaults, examples, root/package docs, and
error text. Operational test setup is included in completeness scans. Secrets
must never appear in warnings.

Proof:

| ID | Proof | Expected | Status |
|---|---|---|---|
| P-C6-1 | Table-driven SDK and OpenClaw env tests: Band only, Thenvoi only, mixed fields, both for one field, account override, missing required, custom prefix, empty prefix. | Required precedence and validation; exact once-per-variable warning cardinality without secret values. | Planned |
| P-C6-2 | Construct clients with defaults and explicit URLs. | Defaults use `app.band.ai`; explicit values are byte-preserved. | Planned |
| P-C6-4 | Assert the derived REST URL follows the changed WS default, that an explicit legacy `wsUrl`/`restUrl` still pins `app.thenvoi.com` end to end, and that SDK and OpenClaw defaults are now byte-identical. | Both defaults resolve to `app.band.ai`; `deriveDefaultRestUrl` tracks the WS host; the documented legacy escape hatch works; Linear deep links use the Band host. | Planned |
| P-C6-3 | Exercise OpenClaw E2E configuration with Band-only, legacy-only, and mixed values including `BAND_API_KEY_USER`; scan published docs, runtime messages, and operational test setup. | E2E eligibility/config agree on precedence and Band defaults; no stale instruction outside migration notes. | Planned |

## C7 — platform tools and MCP contract

Outcome: execute the linked tool/MCP specification, update every prompt and
comparison, and retain the release hold.

Proof: the complete proof matrix is in the linked specification. In addition,
run the broad repository gate and pack/import proof from P-C5-1.

## REL-01 — release 1.0.0, verify, then deprecate

This is an operator sequence. Its pull request is generated by release-please, not hand-authored, so it does not count against the single-PR shape in D-11.

Preconditions:

1. The rename PR (commits C1 through C7) is merged and green; the hold is present.
2. P-PRE-1 passed on `main` before the rename PR, and its evidence is attached to the release handoff.
3. The release workflow still contains the tested guard and package-content gate.
4. The separately owned cursor-pagination migration is complete and verified
   against the server contract that survives the 2026-10-01 sunset.

Operation:

1. Prepare the release PR with `Release-As: 1.0.0`, the complete breaking-change
   guide, and removal of the release-hold marker.
2. Confirm the release guard changes only in that reviewed PR.
3. Publish 1.0.0.
4. In a clean temporary directory, install and import every declared subpath under
   ESM and CJS. Install declared optional peers before testing gated subpaths.
5. Confirm npm version, provenance, required files, and non-empty exports.
6. Only then deprecate `@thenvoi/sdk`, `@thenvoi/rest-client`, and
   `@thenvoi/openclaw-channel-thenvoi`, each naming its replacement.

Failure and rollback:

- if preflight or patch publish fails, keep the hold and do not attempt 1.0.0;
- if 1.0.0 publication fails, do not deprecate anything and never reuse a
  published version number;
- if installation proof fails after publication, mark the version deprecated as
  broken, restore the hold, fix forward, and publish a new patch;
- never deprecate unversioned `@band-ai/rest-client`; its latest is healthy.

Proof:

| ID | Proof | Expected | Status |
|---|---|---|---|
| P-REL-2 | Clean 1.0.0 ESM/CJS import matrix. | Every declared subpath resolves under its declared peer conditions. | Planned |
| P-REL-3 | Query deprecation fields for three old packages and healthy Band latest packages. | Old scopes point to replacements; healthy latest remains non-deprecated. | Planned |

## Requirement trace

| Requirement | Unit and proof |
|---|---|
| R-01, R-02 | PREFLIGHT/C1; P-C1-1 through P-C1-5, P-PRE-1 |
| R-03, R-07 | C5; P-C5-1 through P-C5-3 |
| R-04, R-05, R-08 | C3/C4; P-C3-3, P-C3-3B, P-C4-1 through P-C4-4 |
| R-06, R-10, R-13 | C6; P-C6-1 through P-C6-4 |
| R-09 | C7; linked tool/MCP proof |
| R-12 | C4; P-C4-5, and P-TOOL-08 as backstop |
| R-11 | PREFLIGHT/REL-01; P-PRE-1, P-REL-2, P-REL-3 |
