# Thenvoi to Band: TypeScript SDK decision plan

| Field | Value |
|---|---|
| Status | **APPROVED at round 3 — ready to implement; approval does not authorize implementation, and PREFLIGHT/O-01 remain preconditions** |
| Audience | SDK implementer, release owner, reviewing architect |
| Repository | `band-ai/band-sdk-typescript` |
| Base and research commit | `main` at `ec988c00a786c1c68ed83aa231d8c2cdc4c17c3d` |
| Plan revision | Working-tree revision on PR 139 |
| Delivery | One preflight release operation, **one implementation PR** of seven ordered commits, and one release operation |
| Linked specifications | [Delivery specification](rename-01-implementation-spec.md) · [Storage compatibility](rename-02-storage-compatibility-spec.md) · [Tool and MCP rename](rename-03-tool-mcp-spec.md) · [Cross-repository dependencies](rename-04-cross-repo.md) |

This document is authoritative for scope, decisions, compatibility, sequencing,
and approval. The linked specifications are authoritative only for their named
implementation seams. Rejected designs and review-round transcripts are kept in
git history, not in the executable plan.

## Human summary

The repository publishes `@band-ai/sdk`, but its source package name, public
symbols, configuration, URLs, storage vocabulary, and model-visible tools still
use Thenvoi. The release workflow hides part of this mismatch by rewriting the
package name during publication. The two packages in the workspace also use
different default platform URLs, and CI currently runs empty OpenClaw filters
while reporting success.

The result of this work is one coherent Band-branded 1.0.0 release. Existing
`THENVOI_*` and example-specific `LINEAR_THENVOI_*` environment configuration
continues to start agents with a warning. Existing Linear state databases retain
their path, physical schema, and bindings. TypeScript symbols, platform tool
names, and MCP allowlists are intentional major-version breaks documented in the
release notes. The rename does not move files or rewrite private storage names.

This plan does not rename the platform API, endpoint paths, historical database
migrations in other repositories, GitHub organizations, or Python packages.
Cursor-pagination migration and Fern publishing hardening are important but
independent follow-ups, not steps in this rename.

## Current failures

| ID | Confirmed current behavior | Consequence |
|---|---|---|
| C-01 | CI filters OpenClaw as `@thenvoi/openclaw-channel-thenvoi`; `pnpm --filter` finds no project and exits zero. | OpenClaw typecheck, lint, and tests are false-green. The ungated `packaging` job runs a root `pnpm build` and does still verify OpenClaw dist artifacts, so build coverage is degraded rather than absent. |
| C-02 | `packages/sdk/package.json` says `@thenvoi/sdk`; release publication rewrites it with `sed`. | Source, workspace filters, and published identity disagree. |
| C-03 | The Linear SQLite store creates missing files and initializes empty tables. | Mechanically renaming the default filename would silently abandon live bindings. |
| C-04 | Tool names and `mcp__thenvoi__` are model/host contracts, not ordinary internal symbols. | Misses can remove capabilities without a compile error. |
| C-05 | `.release-please-manifest.json` records SDK 0.1.7 while npm latest is 0.1.6; the current SDK OIDC path has not published successfully. | The major release requires a proven preflight and cannot be the first test of the pipeline. |
| C-06 | The SDK default platform host is `wss://app.thenvoi.com/api/v1/socket` (`platform/ThenvoiLink.ts:49`), and the REST URL is derived from it; OpenClaw already defaults to `app.band.ai`. | Changing the SDK default retargets every consumer that never passed an explicit URL, with no compile error and no warning. |
| C-07 | Root `package.json` carries `pnpm.overrides`, but pnpm 10.22.0 (the pinned `packageManager`) ignores the `pnpm` field and prints a warning on every invocation. | Five security overrides are inert; 1.0.0 would ship with a dependency control that reports nothing and enforces nothing. |

## Desired result and requirements

| ID | Requirement |
|---|---|
| R-01 | CI must fail when a package filter matches nothing and must run both packages' real gates before rename work begins. |
| R-02 | The breaking tree may not publish. The implementation PR installs the repository-owned guard and the hold marker, and the release operation removes the marker only after preconditions pass. |
| R-03 | Source and published package identity must both be `@band-ai/sdk`; publication must not rewrite package metadata. |
| R-04 | Existing Linear SQLite files must retain their physical table, column, and index names and all rows. Public SDK fields may change at the storage mapping boundary; opening under new or old code performs no rename DDL. |
| R-05 | The default example DB path remains `.linear-thenvoi-example.sqlite`. Every renamed `LINEAR_BAND_*` setting falls back per field to its `LINEAR_THENVOI_*` predecessor with a warning, so custom state paths are never silently abandoned. |
| R-06 | Default env loading reads `BAND_*` first, falls back per field to `THENVOI_*`, and warns once per legacy variable used. An explicit custom `prefix` remains exact and gets no implicit fallback. |
| R-07 | Public TypeScript identifiers use Band names with no deprecated aliases. All breaks are collected for the 1.0.0 changelog. |
| R-08 | All six outbound `thenvoi_*` metadata keys and the three brand values in scope move atomically to `band_*`/Band values. No payload may contain a mixed namespace. |
| R-09 | The 17 platform tools advertise and accept only `band_*`; MCP uses `mcp__band__`; every server-name site derives from one constant. Old direct calls, prompts, MCP hosts, and allowlists require an explicit 1.0 migration. |
| R-10 | `app.band.ai` becomes the SDK default. Existing explicit URLs continue unchanged. |
| R-11 | 1.0.0 is published only after trusted-publisher ownership is confirmed, a patch release proves both package paths, package contents are verified, and every subpath is import-tested with required optional peers. |
| R-12 | The six remaining adapter identity strings sent to or published for third parties move to Band in the same unit as R-08: Codex `clientName` and `clientTitle`, Google ADK `APP_NAME` and default agent name, the A2A agent-card skill tag, and the OpenCode `sessionTitlePrefix`. No `thenvoi` brand string may remain reachable on an outbound path without an explicit exclusion row. |
| R-13 | The default-platform-host change is a documented 1.0 runtime break: it must appear in the compatibility contract and lead the release notes. Its `app.thenvoi.com` disposition is recorded in O-04. |

## Scope

Included:

- CI package filters, release hold, and migration of the inert `pnpm.overrides`
  block to a location pnpm 10 actually reads;
- `@band-ai/rest-client@0.0.118` as an isolated dependency swap;
- Linear bridge public names, examples, config vocabulary, and SQLite schema;
- package identity, remaining public Thenvoi symbols, environment configuration,
  defaults, documentation, metadata, adapter identity strings, platform tools,
  MCP prefix, and server name;
- release verification, 1.0.0, and deprecation of the three old-scope packages.

Excluded and tracked separately:

- cursor pagination required before the server's 2026-10-01 sunset;
- Fern generator/publishing hardening and deprecation of the broken exact
  `@band-ai/rest-client@0.0.113` version;
- GitHub organization consolidation and the Python SDK rename/tool mismatch;
- the 82 `linear_thenvoi_bridge.*` observability event names, owned by the
  observability rebrand;
- historical migrations, platform API paths, and `gateway_*`/`a2a_*` routing keys;
- the pre-existing MCP peers-capability enforcement gap.

These exclusions do not gate the rename PR. Cursor pagination and npm
trusted-publisher access both gate REL-01: do not publish a 1.0 whose supported
pagination path has a known 2026-10-01 server sunset.

## Decision ledger

| ID | Decision | Status | Reason |
|---|---|---|---|
| D-01 | Keep the old example DB filename as the compatibility default; do not perform an inferred file move. | Recommended, selected | A missing path is not proof that no state exists. Keeping the filename is safe and reversible. |
| D-02 | Retain legacy physical SQLite table, column, and index names indefinitely; map them to Band public fields at the store boundary. | Revised after review, selected | The store accepts caller-provided databases and does not own database-global versioning. Private branding has no runtime benefit sufficient to justify irreversible DDL. |
| D-03 | Env vars get field-level fallback; symbols do not get aliases. | Selected | Env misses fail silently at runtime; symbol misses fail loudly at compile time. |
| D-04 | Advertise and accept only Band tools; platform tool and MCP names are a clean 1.0 break. | Revised after review, selected | Partial aliases were unreachable on several adapters and conflicted with custom-tool precedence. One explicit migration contract is simpler and testable. |
| D-05 | Rename all outbound brand metadata together. | Directed | The keys are write-only within this SDK; unknown third-party readers are accepted as a major-version risk and called out in release notes. |
| D-06 | PREFLIGHT proves current OIDC on unmodified `main` first; the rename PR's first commit then adds one checked-in guard command used by both publish steps, together with the hold marker. | Revised after review, revised again in round 3 for the single-PR shape, selected | This still proves the real pipeline without ever bypassing a hold, and enforces the hold at the publishing chokepoint. Ordering is preserved by running PREFLIGHT before the PR rather than by splitting the PR. |
| D-11 | Ship the whole rename as one pull request of ordered, unsquashed commits rather than seven PRs. | Directed by the product owner in round 3 | Reviewer preference. Accepted with the rollback-granularity and review-burden costs recorded in the delivery section; the per-unit proof matrix is preserved as per-commit proof so no verification is lost. |
| D-07 | Release with `Release-As: 1.0.0`; do not move the manifest backward. | Selected | Pre-1.0 conventional commits otherwise yield 0.2.0, and 0.1.7 already has a tag. |
| D-08 | Rename the six adapter identity strings rather than retaining them. | Added after review round 2, corrected in round 3, selected | Unlike the SQLite names, none of these is a lookup key for state this SDK later reads back. `GoogleADKAdapter` creates a fresh `randomUUID()` session on every bootstrap and never calls a resume/`getSession` path, so `APP_NAME` partitions only newly created sessions; Codex `clientInfo` and the A2A skill tag are write-only identity. Retention would leave a permanent mixed-brand outbound surface for no compatibility benefit. |
| D-09 | Fix the inert `pnpm.overrides` block inside commit C1 instead of excluding it. | Added after review round 2, selected | It is the same defect class as C-01 — a control reporting success while enforcing nothing — it sits in the workflow files C1 already owns, and shipping 1.0.0 with inert security overrides is worse than a small scope addition. |
| D-10 | Treat the default-host change as a break requiring a recorded disposition for `app.thenvoi.com`, not as a silent default swap. | Added after review round 2, selected | Both hosts answer today, so nothing forces the issue at build or test time; the failure would appear only in a consumer's production traffic after upgrade. |

## Compatibility contract

| Surface | 0.x consumer behavior on upgrade | Migration |
|---|---|---|
| TypeScript imports | Compile failure for renamed symbols | Replace `Thenvoi` with `Band`; use release mapping. |
| Default env variables | Continues working with one warning per legacy field | Set the corresponding `BAND_*` variable. Band wins when both exist. |
| Explicit config prefix | No behavior change | None; caller owns the prefix. |
| YAML Linear example key | New key wins; old key is accepted with a warning for the example runtime | Rename to `linear_band_bridge`. |
| Existing SQLite file | Same path and physical schema open; rows map to Band public fields | No operator action. Old binaries remain able to reopen the file. |
| Direct tool-calling adapter | Old name is rejected as unknown | Update prompts/few-shot examples to `band_*` before upgrading. |
| MCP tool or host allowlist | Old prefix stops exposing the tool | Update `mcp__thenvoi__*` to `mcp__band__*` before upgrading. |
| Outbound metadata reader | Receives Band keys/values only | Update external readers atomically with 1.0.0. |
| Default platform host (no explicit URL passed) | **Silently retargets** from `app.thenvoi.com` to `app.band.ai`; the REST URL follows because it is derived from the WS URL | Pass an explicit `wsUrl`/`restUrl` to pin the old host, or confirm the account is served on `app.band.ai`. Called out first in the release notes because no compile error or warning surfaces it. |
| Explicit platform URL | No behavior change | None; caller owns the URL. |
| A2A agent-card consumer filtering on skill tag `thenvoi` | Tag becomes `band`; the skill stops matching an old tag filter | Update discovery filters to `band` before upgrading. |
| Codex / Google ADK operator dashboards keyed on client or app name | Names change to `band_codex_adapter` / `band`; new sessions group under the new name | Update saved queries. No in-SDK state is keyed on these values. |
| OpenCode / Parlant session titles | New sessions are titled `Band: …` / `Band Room …`; existing titles are unchanged | None. Both are display strings, and OpenCode's prefix stays caller-overridable. |

## Ownership and invariants

| ID | Invariant and owner |
|---|---|
| I-01 | `.github/workflows/ci.yml` owns package-match enforcement; no command relying on a package filter may accept zero matches. |
| I-02 | `.github/workflows/release.yml` owns publication safety and must refuse publishing while the release-hold file exists. |
| I-03 | The SQLite store owns the mapping from retained legacy physical names to Band public fields; rename work executes no schema-changing DDL. |
| I-04 | The runtime tool schema owns canonical tool names; adapters, prompts, and comparisons use only those Band names. |
| I-05 | The config loader owns default-prefix precedence and warnings; custom prefixes retain caller ownership. |
| I-06 | After every implementation PR, both package test counts may stay equal or increase; any decrease requires an explicit reviewed explanation. |
| I-07 | After the first breaking PR, the release hold remains present until the verified release operation removes it. |

## Delivery and release sequence

The rename ships as **one pull request**. Its internal units survive as ordered
commits inside that PR, so the proof matrix, boundaries, and review order are
preserved without splitting delivery.

```text
PREFLIGHT   release operation on current `main` — publish/install-check one
            nonbreaking patch of both packages, proving OIDC before any break
   |
   `---- PR-RENAME  one pull request, seven ordered commits:
            C1  CI repair + zero-match enforcement + guard + hold marker
                + pnpm override migration
            C2  rest-client scope swap to 0.0.118
            C3  Linear symbols/examples/config fallback
            C4  public room-id fields + outbound metadata + adapter identity;
                no DDL
            C5  package identity + all remaining public symbols
            C6  BAND_* config + Band URLs + docs
            C7  platform tools + MCP prefix
               |
               `---- REL-01  verified 1.0.0 release
```

Why PREFLIGHT is not part of the PR. PREFLIGHT must publish a **nonbreaking**
patch of both packages to prove the OIDC path, and it cannot do that from a tree
that already contains the rename. It is therefore a release operation on current
`main`, run before the PR opens — not a second pull request. REL-01 is likewise
not hand-authored: release-please generates the release PR mechanically.

Commit order inside the PR is load-bearing and must be preserved on merge. Use a
merge commit or rebase; **do not squash**, because C1 must remain independently
identifiable as the commit that introduces the hold marker, and because the
per-commit proof matrix is the review unit. INT-404's remaining public symbols are
absorbed by C5. Exact units and proof are in the delivery spec.

Consequences accepted with the single-PR shape:

- rollback is all-or-nothing before REL-01; there is no partial revert of, say,
  the tool rename while keeping the storage mapping;
- the review burden concentrates into one large diff spanning CI, storage, public
  API, tools, and docs, so per-commit review is required rather than optional;
- I-06's test-count comparison is evaluated once against the PREFLIGHT baseline
  rather than seven times.

## Rollout and rollback

- PREFLIGHT proves both package publish paths with nonbreaking contents on current
  `main`, before the rename PR exists. C1 then installs the guard **and** the hold
  marker in the same commit, so the tree is never publishable while it carries a
  break.
- Every commit must leave the tree green; the merged PR must be green and coherent
  on `main`. Coherence does not imply publishability while the hold exists.
- A rollback before REL-01 reverts the whole PR. This is the main cost of the
  single-PR shape and is accepted deliberately. Retained SQLite names allow old and
  new binaries to reopen the same file; no storage restore is introduced by this
  rename.
- REL-01 removes the already-proven hold in the 1.0.0 release PR, publishes,
  install-checks, and only afterward deprecates old packages.
- A failed publish does not remove or deprecate anything. Fix the pipeline,
  restore/retain the hold, and retry with a new immutable version.

## Open owner assignments

These do not change the design, but must be assigned before their step:

| ID | Needed owner | Gate |
|---|---|---|
| O-01 | npm organization owner who can inspect/update trusted-publisher entries for both Band packages | PREFLIGHT, therefore the entire rename PR |
| O-02 | Owner with publish rights to deprecate the three `@thenvoi` packages | Post-publish deprecation only |
| O-03 | Engineering owner for cursor pagination | REL-01 and the 2026-10-01 service deadline; separate implementation plan |
| O-04 | **Answered by the platform team — no owner needed.** Platform routing redirects only browser traffic from the legacy host; API requests and WebSocket upgrades on `app.thenvoi.com` continue to be served unchanged, deliberately, because published SDKs carry that host as their default. The old default therefore keeps working for SDK traffic, making the default change a convenience rather than a hard cutover. | Closed |
| O-05 | **Decided by the product owner during review round 2: `app.band.ai`.** R-10 stands unchanged. Confirmed against `BandEnvironment.Default` in `@band-ai/rest-client@0.0.118`, OpenClaw's existing defaults, and the platform team; `app.band.ai` also resolves live. `platform.*.band.ai` names are internal deployment hostnames, not the SDK-facing host. | Closed |

## Approval criteria

| ID | Observable criterion |
|---|---|
| A-01 | A deliberately invalid package filter fails CI with non-zero status, and real SDK/OpenClaw filters execute non-zero test counts. |
| A-02 | A simulated release-created output cannot reach `npm publish` while the hold exists. |
| A-03 | A pre-rename SQLite fixture reopens with every row exposed under Band public fields while its logical schema dump remains unchanged. |
| A-04 | A legacy env-only fixture starts, warns once per used field, and Band values win field-by-field when both prefixes exist. |
| A-05 | Exact emitted metadata and tool-schema snapshots contain only the selected Band names; no mixed namespace is possible. |
| A-06 | Legacy direct tool calls and old MCP allowlists fail in the documented way; migrated Band calls preserve reporting and reply-delivery behavior. |
| A-07 | A clean install of 1.0.0 resolves all exports under ESM and CJS, with optional peers installed for gated subpaths. |
| A-08 | Old packages are deprecated only after 1.0.0 is confirmed installable; healthy latest packages remain non-deprecated. |
| A-09 | A repository-wide scan of outbound paths finds no reachable `thenvoi` brand string without a matching exclusion row, and every renamed adapter identity string appears in the compatibility contract. |
| A-10 | `pnpm install` emits no ignored-`pnpm`-field warning, and each declared override resolves to the required version in the installed tree. |

## Review findings and status

Rounds 1 and 2 predate D-11, so their dispositions name the old seven-PR units.
Read `PR-00`…`PR-06` as commits `C1`…`C7` of the single rename PR, and proof ids
`P-00-*`…`P-05-*` as `P-C1-*`…`P-C6-*`. The dispositions themselves are unchanged.

Round 1 independently reviewed product/compatibility, persistence/reliability,
and the whole artifact. All three returned REVISE/HELD. Material findings:

| Finding | Disposition |
|---|---|
| PC-01 / WP-01: patch preflight was impossible while the hold existed | **Revised:** PR-00 installs an inactive guard; PREFLIGHT proves both packages; PR-02 activates the hold. |
| PC-02 / WP-02: legacy custom `LINEAR_THENVOI_STATE_DB` could be silently abandoned | **Revised:** all renamed Linear env fields get Band-first legacy fallback and custom-path proof. |
| PC-03 / SQL-PERSIST-01: `user_version` is database-global but the store does not own the database | **Revised:** no physical schema rename or migration version. |
| PC-05 / SQL-PERSIST-02/03/04: migration was irreversible, under-modeled, and hard to prove | **Revised:** retain the physical schema; require a no-DDL logical-schema proof. |
| PC-04 / WP-03: partial tool aliases conflicted with custom tools and were unreachable on LangGraph/MCP | **Revised:** clean 1.0 break on every tool path; no aliases. |
| PC-06: a duplicate release-hold test could be false-green | **Revised:** both real publish steps invoke one tested guard command immediately before `npm publish`. |
| RV-01: OpenClaw env/E2E consumers were outside PR-05 | **Revised:** PR-05 owns both shipped env readers and the E2E-only `BAND_API_KEY_USER` fallback. |
| RV-02: no authoritative public-export migration map survived the rewrite | **Revised:** PR-04 contains the reviewed mapping and generates a declaration/export audit consumed by release notes. |

Because these changes alter persistence, compatibility, and rollout, the complete
revision received a fresh independent whole-artifact review. That round returned
**APPROVE** after verifying the release order, workspace env owners, built public
export inventory, retained SQLite schema, tool and MCP break, pagination release
gate, links, and named filter/build probes.

### Round 2 (repository-verified)

Round 2 re-derived every load-bearing claim from the working tree rather than from
the plan text. Confirmed accurate: C-02 through C-05, the 17-tool count, the six
outbound metadata keys and three brand values, the 82 observability event names,
the retained SQLite identifiers, and the completeness of the C5 export map
(verified by confirming no barrel uses `export *`, so the reachable public surface
is exactly the explicitly re-exported set).

| Finding | Disposition |
|---|---|
| R2-01: outbound adapter identity strings — Codex `clientName`/`clientTitle`, Google ADK `APP_NAME` and default agent name, A2A agent-card skill tag — belonged to no unit and no exclusion, so P-TOOL-08 and the Linear completeness scan could not pass as written | **Revised:** R-12, D-08, the C4 boundary and P-C4-5. Round 3 found this fix itself incomplete and corrected the count from four to six (see R3-01). The round's initial claim that renaming `APP_NAME` would orphan durable ADK sessions was **withdrawn**: the adapter creates a fresh `randomUUID()` session per bootstrap and has no resume path, so this is a scope hole, not a state-compatibility decision. |
| R2-02: the default-host flip was absent from the compatibility contract | **Revised:** C-06, R-13, D-10, three new contract rows, and P-C6-4. O-04 was then **closed by the platform team** (API and WebSocket traffic on the legacy host stays served), and O-05 was **decided by the product owner** in favour of `app.band.ai`. |
| R2-03: PREFLIGHT gated the entire train but named no mechanism for forcing a two-package patch | **Revised:** PREFLIGHT now specifies the mechanism and records that 0.1.7 stays tagged-but-unpublished. |
| R2-04: `pnpm.overrides` silently ignored by the pinned pnpm 10.22.0 | **Revised:** C-07, D-09, folded into C1 with P-C1-5. |
| R2-05: publish-time `cp README.md` defeats the "pack without mutation" proof | **Revised:** C1 defines the README as a required packed entry asserted after the copy, and records the known local/CI packing delta in its own boundary section. |
| R2-06: the rest-client unit's "no REST contract change" was inaccurate | **Revised:** C2 now names the renamed and removed generated symbols and identifies P-C2-1 as the load-bearing proof. |

Baselines measured on the round-2 base (`ec988c0`), for I-06: SDK **696 tests / 88
files**, OpenClaw **156 tests / 9 files**, both green, with typecheck and lint
exiting zero. The previously never-executed OpenClaw suite is not concealing
failures, which confirms PR-00's stated two-workflow boundary.

### Round 3 (repository-verified, single-PR shape)

Round 3 re-reviewed the round-2 revision and the D-11 restructure, and probed the
round-2 fixes themselves.

| Finding | Disposition |
|---|---|
| R3-01: R-12/D-08 said "four" adapter identity strings while listing five sites, and both missed OpenCode `sessionTitlePrefix: "Thenvoi"` (`OpencodeAdapter.ts:138`), which belonged to no unit — the same defect R2-01 was meant to close | **Revised:** count corrected to six, OpenCode added to R-12/D-08/C4 with an explicit note that its neighbouring `mcpServerName` stays with C7. |
| R3-02: the C4 boundary attributed the session title to Parlant only | **Confirmed accurate and extended:** `ParlantAdapter.ts:287` does set `title: "Thenvoi Room …"`, so the original attribution was right; OpenCode's separate prefix is now listed alongside it. |
| R3-03: round 2 asserted "C-01 through C-05 confirmed accurate", but C-01 overstates the build case | **Revised:** C-01 now scopes false-green to typecheck, lint, and test; the ungated `packaging` job runs a root `pnpm build` and does verify OpenClaw dist artifacts. |
| R3-04: PREFLIGHT's mechanism was unverified against the release-please config | **Confirmed:** `release-please-config.json` sets `bump-patch-for-minor-pre-major: true` for both packages and declares no `separate-pull-requests`, so two path-scoped `fix:` commits produce one release PR bumping both. Recorded in PREFLIGHT. |
| R3-05: D-11 (single PR) is incompatible with PREFLIGHT as previously sequenced | **Revised:** PREFLIGHT is reclassified as a release operation on unmodified `main` that runs before the PR opens; the hold marker moves from C3 to C1. REL-01's PR is release-please-generated and does not count against D-11. |

Round 3 verdict is recorded by the reviewer separately; this table records only the
artifact changes made in response.
