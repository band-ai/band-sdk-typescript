# Developing the Band plugin for Claude Code

How to build `@band-ai/claude-code-plugin` from source and test it locally before it is published.
For end-user installation, see [README.md](./README.md).

## Prerequisites

- Node.js 22.14 or later. The repo pins `nodejs 22.22.2` in `.tool-versions`.
- pnpm through Corepack: `corepack pnpm …`. The repo pins `pnpm@10.22.0` in `packageManager`. With
  asdf, plain `pnpm` may fail with `No version is set for command pnpm`; `corepack pnpm` avoids it.
- Claude Code, signed in with a claude.ai account or a Console API key. Checked against 2.1.283.
  To test message delivery, the account must allow channels: personal Pro or Max works as is;
  **Team and Enterprise need an Owner to enable channels for the organization first** (claude.ai →
  Admin settings → Claude Code → Channels). Free has no Claude Code. See the plan table in
  [README.md](./README.md#requirements).
- A Band account for browser sign-in. Use dedicated, clearly named external agents for testing,
  not production identities.
- Optional: Codex CLI, to check the Codex side of the catalog repo.

## Layout

```
packages/claude-code/
├── .claude-plugin/plugin.json   # plugin manifest and userConfig
├── .mcp.json                    # starts dist/server.js, maps userConfig to BAND_* env vars
├── skills/band/                 # copied in from the repo-root skills/band/ at build time
├── src/                         # MCP server: channel push, gating, ack lifecycle, tools, prompt
├── scripts/                     # wasm copy, plugin.json version sync
├── tests/                       # vitest, including a stdio smoke test against dist/
└── tsup.config.ts               # bundles the SDK, phoenix, ws, and the MCP SDK into dist/
```

The published package must be self-contained. Claude Code copies a plugin into its cache and
cannot resolve anything outside it, so `dist/` carries every runtime dependency and the
`band_sdk_core_bg.wasm` file. The package has no runtime `dependencies`.

## Identity lifecycle while testing

- A Claude transcript is bound to one Band agent identity. Resuming that exact transcript restores
  its identity.
- Distinct active Claude sessions should use distinct Band agent identities. A live lease blocks
  two sessions from owning one identity concurrently.
- A new transcript should normally get a new, recognizable identity. Use Claude's resume flow when
  you want to continue with the original identity rather than starting another transcript.
- Band currently has no API for deleting an agent. The plugin cannot clean up identities it
  creates, so do not create a throwaway agent on every run. Prefer names such as
  `claude-local-sdk-auth` that you can recognize and intentionally reuse.

## Build, test, lint

From the repo root:

```bash
corepack pnpm install
corepack pnpm --filter @band-ai/sdk build
corepack pnpm --filter @band-ai/claude-code-plugin build
corepack pnpm --filter @band-ai/claude-code-plugin test
corepack pnpm --filter @band-ai/claude-code-plugin typecheck
corepack pnpm --filter @band-ai/claude-code-plugin lint
```

`build` also syncs the version in `.claude-plugin/plugin.json` from `package.json`. For a rebuild
on every change, run `corepack pnpm --filter @band-ai/claude-code-plugin dev`.

Before a PR, run the whole workspace:

```bash
corepack pnpm -r lint && corepack pnpm -r typecheck && corepack pnpm -r test && corepack pnpm -r build
```

## Rules the server must keep

- **Stdout is the MCP protocol pipe.** Every log line goes to stderr. A stray `console.log`
  corrupts the stdio transport.
- **The server `instructions` must stay under 2,048 characters** for every settings combination.
  Claude Code truncates longer instructions without an error, and a unit test enforces the budget.
  Longer guidance belongs in the `band` skill.
- **Nothing reaches Claude from a sender outside the gate.** Only the agent's owner and
  `BAND_ALLOWED_SENDERS`, and only messages that @mention the agent (direct rooms with the owner
  excepted).
- **Mark a message processed only after Claude replies in its room.** Claude Code drops channel
  events silently when the session did not enable the channel, so acknowledging on push loses
  messages.
- **The MCP SDK must stay bundled.** The tsup plugin stubs optional peers, but
  `@modelcontextprotocol/sdk` is excluded from that list. Check `dist/` after changing
  `tsup.config.ts`.

## Test directly from local source

This is the fastest development loop. `--plugin-dir` loads the working tree for one session and
does not install a marketplace or change Claude Code's plugin registry.

Build from the repository root:

```bash
REPO_ROOT="$PWD"
corepack pnpm install
corepack pnpm --filter @band-ai/sdk build
corepack pnpm --filter @band-ai/claude-code-plugin build
claude plugin validate "$REPO_ROOT/packages/claude-code"
```

Create an isolated settings file. The inline plugin ID is `band@inline`; no agent UUID or API key
belongs in this file:

```bash
mkdir -p ~/.config/band-dev
cat > ~/.config/band-dev/settings.json <<'EOF'
{
  "pluginConfigs": {
    "band@inline": {
      "options": {
        "platform_url": "https://app.band.ai",
        "enable_contacts": false,
        "enable_memory": true
      }
    }
  }
}
EOF
chmod 600 ~/.config/band-dev/settings.json
```

Start Claude Code from a scratch project so plugin testing does not mix with repository work:

```bash
mkdir -p /tmp/band-plugin-project
cd /tmp/band-plugin-project
claude \
  --plugin-dir "$REPO_ROOT/packages/claude-code" \
  --settings ~/.config/band-dev/settings.json \
  --dangerously-load-development-channels plugin:band@inline \
  --debug-file /tmp/band-plugin-debug.log
```

Walk through the actual connection:

1. Accept the development-channels warning. The startup screen must not show
   `Channels are not enabled for your org`; if it does, see
   [Channels on Team and Enterprise accounts](#channels-on-team-and-enterprise-accounts).
2. Run `/mcp` and confirm `plugin:band:band` is connected while still signed out of Band.
3. Ask Claude: `Connect this transcript to Band.` Complete browser sign-in.
4. List identities. For a new transcript, create a clearly named external agent rather than
   borrowing the identity of another session. Remember that the platform has no agent-deletion API.
5. From Band, open a room with that identity and send a message that @mentions it. The message
   should appear as an inbound channel line, and Claude should answer in the same room.
6. Quit and resume the same Claude transcript. It should restore the same Band identity without
   asking you to select it again.
7. Start a second Claude transcript concurrently and select or create a different identity. Trying
   the first identity should report that it is owned by another session.

For source edits, rebuild and run `/reload-plugins`, or, from the repository root in a second
terminal, run the plugin build watcher:

```bash
corepack pnpm --filter @band-ai/claude-code-plugin dev
```

The watcher does not rebuild `packages/sdk`; rebuild `@band-ai/sdk` before the plugin when SDK
source changes.

In `/tmp/band-plugin-debug.log`, look for:

- `MCP server "plugin:band:band": Successfully connected`
- no `Server instructions truncated` line
- no `Channel notifications skipped` line for `plugin:band:band`

The server's own stderr does not appear in that log or in Claude Code's per-server log
(`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-plugin-band-band/` on macOS). To see it,
run the server on its own (see [Debugging the server on its own](#debugging-the-server-on-its-own)).

For a quick signed-out check of the tool list:

```bash
claude -p "List every tool whose name contains band, comma-separated, then DONE." \
  --plugin-dir "$REPO_ROOT/packages/claude-code" \
  --settings ~/.config/band-dev/settings.json \
  --max-turns 1 < /dev/null
```

The list must include `band_authenticate`, `band_connection_status`, and `band_connect_session`.
Contact tools should appear only when `enable_contacts` is true; memory tools should follow
`enable_memory`.

### Channels on Team and Enterprise accounts

On claude.ai Team and Enterprise, channels stay off until an Owner enables them for the
organization, and the development flag does not bypass that. With channels off:

- the startup screen shows `Channels are not enabled for your org`,
- the debug log shows
  `MCP server "plugin:band:band": Channel notifications skipped: channels not enabled by org policy`,
- the plugin still connects to Band and receives the message: in Band it moves to "processing",
  then Claude Code drops it without an error.

Fix: an Owner enables channels (claude.ai → Admin settings → Claude Code → Channels, or
`channelsEnabled: true` in managed settings). Then quit and restart Claude Code; a session started
before the change keeps the old setting. Messages that were dropped stay at "processing", so send
a new one. Alternatively, test with a personal Pro or Max login, or a Console API key in an
organization without managed settings.

## Create and host a marketplace

A Claude Code marketplace is a catalog, not the plugin artifact. The Band entry points to the
published `@band-ai/claude-code-plugin` npm package because that package contains the built
`dist/` directory. This repository already includes the production-shaped catalog at
`.claude-plugin/marketplace.json`.

To create a dedicated marketplace repository:

```bash
MARKETPLACE=../band-agent-plugins
mkdir -p "$MARKETPLACE/.claude-plugin"
cat > "$MARKETPLACE/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "band-ai",
  "description": "Band AI plugins for Claude Code",
  "owner": {
    "name": "Band",
    "email": "hello@band.ai",
    "url": "https://band.ai"
  },
  "plugins": [
    {
      "name": "band",
      "description": "Connect this Claude Code session to the Band AI agent collaboration platform.",
      "source": {
        "source": "npm",
        "package": "@band-ai/claude-code-plugin"
      }
    }
  ]
}
EOF

claude plugin validate "$MARKETPLACE"
```

The marketplace entry name and `.claude-plugin/plugin.json` name must both remain `band`. The
marketplace name is `band-ai`, so the install ID is `band@band-ai`.

Commit and push the catalog to a Git repository:

```bash
cd "$MARKETPLACE"
git init
git add .claude-plugin/marketplace.json
git commit -m "Add Band Claude Code plugin"
git branch -M main
git remote add origin git@github.com:band-ai/band-agent-plugins.git
git push -u origin main
```

The npm package must be published before users can install this catalog entry. For a pre-publish
test, use the local registry walkthrough below.

## Install from the hosted marketplace

An end user registers the marketplace once and installs the plugin:

```bash
claude plugin marketplace add band-ai/band-agent-plugins
claude plugin install band@band-ai
claude plugin list
claude plugin details band
```

Restart Claude Code if requested, then start a channel-enabled session:

```bash
claude --dangerously-load-development-channels plugin:band@band-ai
```

Run `/mcp`, connect the transcript through browser sign-in, and select or create its dedicated Band
identity. To update later:

```bash
claude plugin marketplace update band-ai
claude plugin update band@band-ai
```

## Install a built Git checkout through a local marketplace

Claude Code can fetch plugin sources from Git, but it does not install dependencies or run builds.
This repository intentionally does not commit `dist/`, so a direct `git-subdir` source would be
incomplete. Clone the desired revision, build it, pack the self-contained plugin, and expose that
artifact through a local marketplace:

```bash
git clone https://github.com/band-ai/band-sdk-typescript.git
cd band-sdk-typescript
git checkout COMMIT_OR_TAG
corepack pnpm install
corepack pnpm --filter @band-ai/sdk build
corepack pnpm --filter @band-ai/claude-code-plugin build
```

This checks the exact artifact built from that Git revision while keeping the installed name
separate from the production marketplace. The throwaway Claude Code config keeps the smoke test
out of your normal settings:

```bash
SMOKE=/tmp/band-plugin-smoke
rm -rf "$SMOKE" && mkdir -p "$SMOKE"/{pack,mkt/.claude-plugin,home}

corepack pnpm --filter @band-ai/claude-code-plugin pack --pack-destination "$SMOKE/pack"
tar -tzf "$SMOKE"/pack/*.tgz | grep -v '\.map$'     # expect dist/, .claude-plugin/, .mcp.json, skills/

tar -xzf "$SMOKE"/pack/*.tgz -C "$SMOKE/mkt" && mv "$SMOKE/mkt/package" "$SMOKE/mkt/band"
cat > "$SMOKE/mkt/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "band-smoke",
  "owner": { "name": "Band" },
  "plugins": [{ "name": "band", "source": "./band" }]
}
EOF

export CLAUDE_CONFIG_DIR="$SMOKE/home"
claude plugin validate "$SMOKE/mkt/band"
claude plugin validate "$SMOKE/mkt"
claude plugin marketplace add "$SMOKE/mkt"
claude plugin install band@band-smoke
claude plugin details band@band-smoke
claude mcp list                                     # expect plugin:band:band … Connected
claude plugin uninstall band@band-smoke
unset CLAUDE_CONFIG_DIR
rm -rf "$SMOKE"
```

The throwaway config directory is not signed in to Claude or Band, so it covers artifact contents,
marketplace registration, signed-out MCP health, and uninstall. To keep this Git build installed,
omit `CLAUDE_CONFIG_DIR`, the uninstall, and the final cleanup. Use
[Test directly from local source](#test-directly-from-local-source) for browser authentication and
message delivery while iterating.

## Test the npm-backed marketplace before release

The catalog repo, `band-ai/band-agent-plugins`, lists the plugin with an `npm` source. To test that
path before publishing, serve the tarball from a local registry:

```bash
SMOKE=/tmp/band-plugin-npm
rm -rf "$SMOKE" && mkdir -p "$SMOKE"/{pack,home,verdaccio}
corepack pnpm --filter @band-ai/claude-code-plugin pack --pack-destination "$SMOKE/pack"

cat > "$SMOKE/verdaccio/config.yaml" <<EOF
storage: $SMOKE/verdaccio/storage
auth:
  htpasswd:
    file: $SMOKE/verdaccio/htpasswd
    max_users: -1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  "@band-ai/claude-code-plugin":
    access: \$all
    publish: \$anonymous \$all
  "**":
    access: \$all
    proxy: npmjs
listen: 127.0.0.1:4873
EOF
npx -y verdaccio@6 --config "$SMOKE/verdaccio/config.yaml" &   # stop it when done

printf '@band-ai:registry=http://127.0.0.1:4873/\n//127.0.0.1:4873/:_authToken=local\n' > "$SMOKE/npmrc"
npm publish "$SMOKE"/pack/*.tgz --registry http://127.0.0.1:4873 --userconfig "$SMOKE/npmrc"

export CLAUDE_CONFIG_DIR="$SMOKE/home" npm_config_userconfig="$SMOKE/npmrc"
claude plugin marketplace add /path/to/band-agent-plugins   # local checkout of the catalog repo
claude plugin install band@band-ai
claude mcp list
claude plugin uninstall band@band-ai
unset CLAUDE_CONFIG_DIR npm_config_userconfig
```

The scoped `@band-ai:registry` line matters: `claude plugin install --registry` applies only to the
`<package>@npm` form, not to a marketplace entry.

### Codex side of the catalog

The catalog repo also carries `.agents/plugins/marketplace.json` for Codex. Without it, Codex falls
back to `.claude-plugin/marketplace.json` and offers this Claude Code plugin to Codex users. To
check:

```bash
export CODEX_HOME=$(mktemp -d)
codex plugin marketplace add /path/to/band-agent-plugins
codex plugin list        # must not list the Claude Code plugin
rm -rf "$CODEX_HOME"; unset CODEX_HOME
```

## Debugging the server on its own

Run the built server without Claude Code and send one `initialize` request:

```bash
CLAUDE_SESSION_ID=00000000-0000-4000-8000-000000000001
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dev","version":"0"}}}' \
  | CLAUDE_CODE_SESSION_ID="$CLAUDE_SESSION_ID" CLAUDE_PROJECT_DIR="$PWD" \
    node packages/claude-code/dist/server.js
```

Stdout must be exactly one JSON-RPC response advertising
`capabilities.experimental["claude/channel"]` and the `instructions`. Everything else goes to
stderr. The server initializes while signed out; Band REST/WebSocket connections start only after
`band_authenticate` and `band_connect_session` complete.

## Releasing

- release-please versions the package from Conventional Commits. `build` copies the version into
  `.claude-plugin/plugin.json`, so the two never drift.
- Publishing the npm package is what users install. The catalog entry points at
  `@band-ai/claude-code-plugin` on npm and needs no change for a new version.
- After a release, users get it with `claude plugin marketplace update band-ai` and
  `claude plugin update band@band-ai`.
