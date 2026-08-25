# NemoClaw + Band Demo

Demo setup for running the `@band-ai/openclaw-channel-band` channel plugin inside a NemoClaw sandbox on a Mac, with Anthropic Claude as the inference backend.

Band credentials are stored in the sandbox's OpenClaw config (`/sandbox/.openclaw/openclaw.json`), not in host env vars.

## Prerequisites

- macOS (Apple Silicon)
- Docker Desktop or Colima running
- Xcode CLI tools: `xcode-select --install`
- `ANTHROPIC_API_KEY` exported in your shell
- Band agent ID + API key (provide them at step 4, not via env)

## 1. Install NemoClaw

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
source ~/.zshrc
```

## 2. Onboard the sandbox

```bash
cd packages/openclaw/examples/nemoclaw
nemoclaw onboard --from ./Dockerfile
```

In the wizard:

- Pick the **`routed`** inference profile.
- Confirm `ANTHROPIC_API_KEY` registration.
- Decline the bundled Slack/Discord/Telegram channels.
- If the wizard offers to extend the router pool, add:
  ```yaml
  - name: claude-sonnet-4-6
    display_name: "Claude Sonnet 4.6"
    litellm_model: anthropic/claude-sonnet-4-6
    api_base: https://api.anthropic.com
    credential_env: ANTHROPIC_API_KEY
  ```

## 3. Apply egress policy

Replace `band-demo` with the sandbox name you chose at onboard:

```bash
nemoclaw band-demo policy-add --from-file ./presets/band.yaml
```

## 4. Configure the Band channel account

```bash
nemoclaw band-demo connect
```

Inside the sandbox shell, paste your actual Band credentials directly into the config (these stay inside the sandbox, never in env vars or the repo):

```bash
openclaw config set channels.openclaw-channel-band.accounts.primary.enabled true
openclaw config set channels.openclaw-channel-band.accounts.primary.apiKey  '<your-band-api-key>'
openclaw config set channels.openclaw-channel-band.accounts.primary.agentId '<your-band-agent-id>'
```

## 5. Start the agent

Still inside the sandbox shell:

```bash
openclaw agent --agent main
```

Watch for:

- `[band] Plugin loaded, channel registered`
- Phoenix Channels join activity

## 6. Verify (M1)

In the Band app, open a chat room with the agent and `@`-mention it. Expected: a Claude-generated reply appears in the room.

If nothing arrives, OpenShell's TUI will surface any blocked-egress prompts for operator approval — most likely candidate is the WSS upgrade to `app.band.ai`.
