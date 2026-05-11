# Band on NemoClaw integration setup

This runbook is for the NVIDIA NemoClaw integration path. It uses the existing `@thenvoi/openclaw-channel-thenvoi` OpenClaw channel package and generates a NemoClaw custom-image build context that bakes the plugin into the sandbox.

The goal is a visible Band room round trip: a Band room message reaches the OpenClaw agent inside NemoClaw, and the reply appears back in Band.

## What this setup does

The integration setup script:

1. verifies the OpenClaw channel package has been built;
2. copies `dist/index.js`, `dist/index.d.ts`, and `openclaw.plugin.json` into a narrow build context;
3. generates a Dockerfile that copies the plugin into `/sandbox/.openclaw/extensions/openclaw-channel-thenvoi`;
4. runs `openclaw doctor --fix` in the image after the plugin is copied;
5. merges a Band account entry into `/sandbox/.openclaw/openclaw.json` so OpenClaw starts the plugin account;
6. writes a Band config template with placeholders only;
7. writes a Band egress policy for the configured Band REST/WebSocket host;
8. ships a configure command that writes Band credentials into the running sandbox config without baking them into the image;
9. prints the `nemoclaw onboard --from <Dockerfile>` command.

Do not use `nemoclaw <sandbox> skill install` for this plugin. NemoClaw documents that command for agent skills, not OpenClaw plugin packages.

## Prerequisites

- Node and pnpm installed for this repo.
- NemoClaw CLI installed and on `PATH` for real sandbox onboarding.
- A NemoClaw-compatible sandbox base image or Dockerfile.
- Low-privilege Band integration credentials:
  - `THENVOI_API_KEY`
  - `THENVOI_AGENT_ID`
- A Band integration room ID for the final room round trip.

## Build the Band OpenClaw channel

From the TypeScript SDK workspace:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi build
pnpm --filter @thenvoi/openclaw-channel-thenvoi test
pnpm --filter @thenvoi/openclaw-channel-thenvoi typecheck
pnpm --filter @thenvoi/openclaw-channel-thenvoi lint
```

## Generate the NemoClaw integration context

Use a known NemoClaw/OpenClaw sandbox base image:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:setup -- \
  --sandbox band-integration \
  --base-image ghcr.io/nvidia/nemoclaw/sandbox-base:latest \
  --yes
```

Do not put Band credentials in the generated image unless you need a disposable local build. The supported path below writes credentials into the running sandbox config after onboarding.

Or use a local NemoClaw-compatible Dockerfile as the source:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:setup -- \
  --sandbox band-integration \
  --from /path/to/NemoClaw/Dockerfile \
  --yes
```

The generated context is written to:

```text
packages/openclaw/dist/nemoclaw-integration/band-integration/
```

Review these files before onboarding:

- `Dockerfile`
- `band-egress-policy.yaml`
- `openclaw-channel-thenvoi.openclaw-config.json`
- `openclaw-channel-thenvoi.config.example.json`
- `openclaw-channel-thenvoi/openclaw.plugin.json`

## Onboard the sandbox

The setup script prints the exact command. It has this shape:

```sh
nemoclaw onboard --from /absolute/path/to/packages/openclaw/dist/nemoclaw-integration/band-integration/Dockerfile --name band-integration
```

## Apply Band egress policy

After onboarding, apply the generated Band policy preset:

```sh
nemoclaw band-integration policy-add --from-file /absolute/path/to/packages/openclaw/dist/nemoclaw-integration/band-integration/band-egress-policy.yaml --yes
```

The policy allows only the configured Band REST/WebSocket host. Review it against the installed NemoClaw policy schema before applying it.

## Preflight without Band credentials

Run context-only preflight if NemoClaw is not installed yet:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:preflight -- \
  --sandbox band-integration \
  --context-only
```

Run full offline preflight after the sandbox exists:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:preflight -- \
  --sandbox band-integration
```

This checks the generated context, manifest tool declarations, `nemoclaw list --json`, and documented sandbox readiness through `nemoclaw band-integration status`.

## Configure Band credentials

Use integration-scoped credentials. Do not commit real values.

```sh
export THENVOI_API_KEY=<redacted>
export THENVOI_AGENT_ID=<agent-id>
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:configure -- \
  --sandbox band-integration
```

The generated OpenClaw config enables the Band account without baking credentials into the image. `nemoclaw:integration:configure` reads the environment variables, writes them into `/sandbox/.openclaw/openclaw.json` with `nemoclaw band-integration config set`, and restarts the sandbox agent process. This is better than `--embed-credentials-from-env` for a running instance because credentials stay out of the Docker build context and image layers.

## Live integration verification

After preflight passes and Band credentials are exported, run the live verifier while the sandbox is connected:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:verify -- \
  --sandbox band-integration \
  --room <room-id>
```

The verifier checks the generated context, documented NemoClaw readiness commands (`nemoclaw list --json` and `nemoclaw <sandbox> status`), Band REST `getAgentMe`, Band WebSocket presence, and the room reply proof. For the final layer, keep the command running, send the exact nonce prompt printed by the verifier in the integration Band room, and wait for the verifier to observe a new Band-visible reply from `THENVOI_AGENT_ID` that includes that nonce.

Use `--skip-room` only for a credential/connectivity smoke. That mode is not a complete integration proof because it does not prove the visible room round trip.

## Integration success criteria

A complete integration is only successful when all of these are true:

1. NemoClaw sandbox builds from the generated Dockerfile.
2. OpenClaw discovers `openclaw-channel-thenvoi`.
3. OpenClaw sees all 12 `thenvoi_*` tools.
4. Band REST validation succeeds with `getAgentMe`.
5. Band WebSocket presence starts.
6. A nonce prompt in the integration Band room reaches the NemoClaw/OpenClaw agent.
7. `nemoclaw:integration:verify -- --room <room-id>` observes a new Band-visible reply from the configured agent that includes the nonce.

## Failure map

| Symptom | Likely layer | First check |
|---|---|---|
| `nemoclaw` not found | Host setup | Install NemoClaw CLI and rerun preflight |
| Docker build cannot find plugin files | Generated context | Rerun `nemoclaw:integration:setup -- --yes` after `pnpm build` |
| OpenClaw does not list contact tools | Plugin manifest | Check `openclaw.plugin.json` contains all 12 tools |
| REST/WebSocket cannot reach Band | NemoClaw policy | Review/apply `band-egress-policy.yaml` |
| Credential error | Band config | Verify integration `THENVOI_API_KEY` and `THENVOI_AGENT_ID` |
| Message reaches sandbox but no reply returns | Runtime dispatch | Check logs for `OpenClaw dispatch unavailable` |
| Reply exists in logs but not in Band | Band REST reply path | Check `createChatMessage` errors and redacted gateway logs |

## Backup integration artifact

Before the NVIDIA meeting, capture a successful run if possible:

- generated context directory listing;
- `nemoclaw:integration:preflight` JSON output;
- OpenClaw tool list showing all 12 `thenvoi_*` tools;
- Band room transcript showing the integration message and reply.

Keep credentials out of screenshots and logs.
