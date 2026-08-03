# Platform tool and MCP rename specification

| Field | Value |
|---|---|
| Status | **APPROVED** |
| Decision authority | [Decision plan](rename-00-overview.md), D-04 |
| Delivery unit | [C7](rename-01-implementation-spec.md#c7--platform-tools-and-mcp-contract), the final commit in the single rename PR |

## Contract

The canonical tool registry advertises the same 17 capabilities under `band_*`
names. Contact and memory group membership remains unchanged. MCP-qualified names
use `mcp__band__<band_tool_name>`.

The mapping is mechanical by prefix:

```text
thenvoi_<operation>  -> band_<operation>
mcp__thenvoi__<tool> -> mcp__band__<tool>
```

This changes names only, not tool arguments, result schemas, capability policy,
or handler behavior.

## Canonical ownership

- `TOOL_MODELS` and its exported key type own canonical unqualified names.
- `MCP_TOOL_PREFIX = "mcp__band__"` owns qualification.
- one exported `MCP_SERVER_NAME = "band"` owns all MCP server-name defaults and
  integrations; no independent `"thenvoi"` server literal remains.
- prompts, silent-reporting sets, reply-delivery checks, schema groups, and tests
  consume canonical constants instead of copying strings where practical.

Completeness tests assert exact sets. A grep is a backstop, not the primary proof.

## Clean 1.0 compatibility break

Advertise and accept Band names only. Do not normalize or register legacy
`thenvoi_*` calls on any adapter. A raw legacy name that reaches the SDK follows
the existing unknown-tool path; registration-based adapters never expose it.

This intentionally matches TypeScript symbol and MCP-prefix behavior. It avoids
an adapter-specific compatibility promise that is impossible on LangGraph,
Google ADK, ACP/OpenCode, and MCP, and it preserves current custom-tool lookup and
collision semantics. Release notes must describe prompts and saved tool-call
examples as upgrade prerequisites, not as temporarily compatible inputs.

## Intentional MCP break

An old host allowlist such as `mcp__thenvoi__*` will expose no renamed tools. The
SDK cannot repair a capability the host never sends to it. Release notes must put
this migration before prompt changes:

1. change host allowlists to `mcp__band__*`;
2. update explicit server name `thenvoi` to `band` where configured;
3. update prompts and examples from `thenvoi_*` to `band_*`;
4. deploy SDK 1.0.0.

Do not register both prefixes. Dual registration doubles model-visible tools and
still does not fix host policies that allow only the old server.

## Failure and security boundaries

- Argument validation and handler authorization/capability behavior do not move.
- Custom-tool lookup and collision rules remain unchanged; no alias can redirect
  a legacy custom-tool name to a platform handler.
- Execution events and errors use the Band canonical name for Band calls.
- `band_send_message` must suppress duplicate reporting and count as reply
  delivered in Codex; legacy `thenvoi_send_message` is rejected/unknown.
- Capability enforcement gaps discovered during this rename are separate fixes;
  do not imply that renaming closes them.

## Executable proof matrix

| ID | Input/path | Expected | Status |
|---|---|---|---|
| P-TOOL-01 | Enumerate `TOOL_MODELS`, contact group, and memory group. | Exactly 17 unique `band_*` keys; group members are valid keys and counts unchanged. | Planned |
| P-TOOL-02 | Generate MCP registrations/backends. | Every qualified name is `mcp__band__band_*`; no old prefix advertised. | Planned |
| P-TOOL-03 | Instantiate every MCP/server bridge with default name. | All report the one Band server constant. | Planned |
| P-TOOL-04 | Call raw-name adapters with every old name, then every new name. | Old names follow unknown-tool behavior; new names execute the corresponding existing handler. | Planned |
| P-TOOL-05 | Codex Band `send_message` and `send_event` calls with execution reporting enabled. | No spurious report; send_message marks reply delivered; no duplicate fallback reply. | Planned |
| P-TOOL-06 | Legacy-named and canonical-name-colliding custom tools under current adapter rules. | Custom-tool precedence/collision behavior is unchanged by the platform rename. | Planned |
| P-TOOL-07 | MCP host configured only with `mcp__thenvoi__*`, then with `mcp__band__*`. | Old configuration exposes none; migrated configuration exposes intended tools. | Planned |
| P-TOOL-08 | Search runtime prompts, tool comparisons, server literals, docs, and tests. | No unowned legacy tool/prefix/server hit outside migration notes. Adapter identity strings (Codex `clientName`/`clientTitle`, ADK `APP_NAME`/agent name, A2A skill tag, OpenCode `sessionTitlePrefix`) are owned by C4 and must already be Band by the time this runs; the 82 `linear_thenvoi_bridge.*` event names and the retained SQLite physical identifiers are the only permitted legacy hits. | Planned |
| P-TOOL-09 | Run all adapter, MCP, runtime-tool, and Claude bridge tests plus broad gate. | Non-zero tests, no failures, no reduced baseline without explanation. | Planned |
