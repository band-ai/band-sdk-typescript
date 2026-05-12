# Set up Band on NemoClaw

This guide walks through running a Band-connected OpenClaw agent inside a NemoClaw sandbox. After setup, you add the Band agent to a Band chat room and talk to it like any other Band participant.

The integration uses the `@thenvoi/openclaw-channel-thenvoi` OpenClaw channel package. The setup script generates a NemoClaw custom-image build context that installs the plugin at `/sandbox/.openclaw/extensions/openclaw-channel-thenvoi`, adds the OpenClaw plugin config, and writes a Band egress policy for the configured Band host.

Do not use `nemoclaw <sandbox> skill install` for this package. NemoClaw skills and OpenClaw plugins are different install surfaces; this package must be installed as an OpenClaw plugin inside the NemoClaw image.

## What you need

- Node and pnpm installed for this repo.
- NemoClaw CLI installed and on `PATH`.
- A NemoClaw-compatible sandbox base image or Dockerfile.
- A Band agent with integration credentials:
  - `THENVOI_API_KEY`
  - `THENVOI_AGENT_ID`
- A model provider configured for NemoClaw.

For a quick public setup, sign up for NVIDIA AI, create an API key, and use an OpenAI-compatible NVIDIA-hosted model such as `z-ai/glm4.7` if it is available in your NVIDIA account. NemoClaw can route OpenClaw's model traffic through the NVIDIA endpoint while the Band plugin handles chat connectivity.

## 1. Build the Band OpenClaw channel

From the TypeScript SDK workspace:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi build
pnpm --filter @thenvoi/openclaw-channel-thenvoi test
pnpm --filter @thenvoi/openclaw-channel-thenvoi typecheck
pnpm --filter @thenvoi/openclaw-channel-thenvoi lint
```

The setup command copies the built `dist/index.js`, `dist/index.d.ts`, and `openclaw.plugin.json` files into the generated NemoClaw build context.

## 2. Generate the NemoClaw build context

Use a NemoClaw/OpenClaw sandbox base image:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:setup -- \
  --sandbox band-integration \
  --base-image ghcr.io/nvidia/nemoclaw/sandbox-base:latest \
  --yes
```

Or use your own NemoClaw-compatible Dockerfile:

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

Review these generated files before onboarding:

- `Dockerfile`
- `band-egress-policy.yaml`
- `openclaw-channel-thenvoi.openclaw-config.json`
- `openclaw-channel-thenvoi.config.example.json`
- `openclaw-channel-thenvoi/openclaw.plugin.json`

Do not bake real Band credentials into the image unless you are creating a disposable local sandbox. The supported path writes credentials into the running sandbox after onboarding.

## 3. Configure a NemoClaw model provider

NemoClaw needs a model before OpenClaw can answer Band messages. If you use NVIDIA AI, create an NVIDIA API key and choose an OpenAI-compatible model, for example `z-ai/glm4.7` when available.

For non-interactive onboarding with NemoClaw's OpenAI-compatible provider, set the provider endpoint and credential before `nemoclaw onboard`:

```sh
export NEMOCLAW_PROVIDER=custom
export NEMOCLAW_ENDPOINT_URL=https://integrate.api.nvidia.com/v1
export NEMOCLAW_MODEL=z-ai/glm4.7
export COMPATIBLE_API_KEY=<your-nvidia-api-key>
```

If your NemoClaw version has a named NVIDIA provider, use the equivalent provider option from `nemoclaw onboard` and keep the same model intent: a hosted OpenAI-compatible chat model reachable from inside the sandbox.

NemoClaw's current non-interactive OpenAI-compatible flow requires `NEMOCLAW_ENDPOINT_URL`. Without it, onboarding exits with `Endpoint URL is required for Other OpenAI-compatible endpoint`, and sandbox status can only report `Endpoint URL is not known; skipping reachability check.`

## 4. Onboard the sandbox

The setup script prints the exact command. It has this shape:

```sh
nemoclaw onboard --from /absolute/path/to/packages/openclaw/dist/nemoclaw-integration/band-integration/Dockerfile --name band-integration
```

For non-interactive onboarding with the environment variables above:

```sh
nemoclaw onboard --non-interactive --yes \
  --from /absolute/path/to/packages/openclaw/dist/nemoclaw-integration/band-integration/Dockerfile \
  --name band-integration
```

After onboarding, confirm NemoClaw sees the sandbox and model:

```sh
nemoclaw list --json
nemoclaw band-integration status
```

`nemoclaw band-integration status` should show the sandbox as ready and should not report missing model endpoint configuration.

## 5. Apply the Band egress policy

After onboarding, apply the generated Band policy preset:

```sh
nemoclaw band-integration policy-add --from-file /absolute/path/to/packages/openclaw/dist/nemoclaw-integration/band-integration/band-egress-policy.yaml --yes
```

The policy allows the sandbox to reach the configured Band REST and WebSocket host. By default that host is `app.band.ai`.

## 6. Configure Band credentials

Create or choose a Band agent, then get its integration API key and agent ID from Band. Export them locally without committing them:

```sh
export THENVOI_API_KEY=<your-band-api-key>
export THENVOI_AGENT_ID=<your-band-agent-id>
```

Write those credentials into the running NemoClaw sandbox:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:configure -- \
  --sandbox band-integration
```

`nemoclaw:integration:configure` writes `restUrl`, `wsUrl`, `agentId`, and `apiKey` into `/sandbox/.openclaw/openclaw.json` with `nemoclaw band-integration config set`, then restarts the sandbox agent process. Credentials stay out of the Docker build context and image layers.

## 7. Talk to the agent in Band

Open Band, add the configured Band agent to a chat room, and send it a message. If the room has multiple participants, mention the agent so the Band channel knows the message is intended for it.

The expected user experience is simple: the message appears in Band, OpenClaw inside NemoClaw receives it, the configured model generates an answer, and the Band agent replies in the same room.

Use the verifier when you want a scripted smoke test, not as the normal product flow:

```sh
pnpm --filter @thenvoi/openclaw-channel-thenvoi run nemoclaw:integration:verify -- \
  --sandbox band-integration \
  --room <room-id>
```

The verifier checks generated files, `nemoclaw list --json`, `nemoclaw <sandbox> status`, Band REST `getAgentMe`, Band WebSocket presence, and whether the configured agent can reply in a Band room. Normal users do not need to run it after every setup.

## Optional preflight checks

Run context-only preflight before NemoClaw is installed or before the sandbox exists:

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

This checks the generated context, plugin manifest tool declarations, Band policy/config templates, `nemoclaw list --json`, and `nemoclaw band-integration status`.

## Troubleshooting

| Symptom | Likely layer | First check |
|---|---|---|
| `nemoclaw` not found | Host setup | Install NemoClaw CLI and rerun preflight |
| Docker build cannot find plugin files | Generated context | Rerun `pnpm build`, then `nemoclaw:integration:setup -- --yes` |
| NemoClaw reports missing endpoint URL | Model setup | Set `NEMOCLAW_ENDPOINT_URL` before non-interactive onboarding |
| NemoClaw inference is unhealthy | Model setup | Check the model ID, provider endpoint, and provider API key |
| OpenClaw does not list Band tools | Plugin install | Check `openclaw.plugin.json` contains all 12 `thenvoi_*` tools |
| REST/WebSocket cannot reach Band | NemoClaw policy | Apply or review `band-egress-policy.yaml` |
| Credential error | Band config | Verify `THENVOI_API_KEY` and `THENVOI_AGENT_ID` |
| Agent is in the room but does not answer | Runtime dispatch | Check `nemoclaw band-integration logs` for Band/OpenClaw dispatch errors |
| Reply exists in logs but not in Band | Band REST reply path | Check `createChatMessage` errors and redacted gateway logs |

## Support artifact

When validating a new environment or reporting setup issues, capture:

- generated context directory listing;
- `nemoclaw:integration:preflight` JSON output;
- `nemoclaw band-integration status` output;
- OpenClaw tool list showing all 12 `thenvoi_*` tools;
- a Band room transcript showing a normal message to the agent and its reply.

Keep credentials out of screenshots and logs.
