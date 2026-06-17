# NemoClaw + Thenvoi Demo

Demo setup for running the `@thenvoi/openclaw-channel-thenvoi` channel plugin inside a NemoClaw sandbox on a Mac, with Anthropic Claude as the inference backend.

Thenvoi credentials are stored in the sandbox's OpenClaw config (`/sandbox/.openclaw/openclaw.json`), not in host env vars.

## Prerequisites

- macOS (Apple Silicon)
- Docker Desktop or Colima running
- Xcode CLI tools: `xcode-select --install`
- `ANTHROPIC_API_KEY` exported in your shell
- Thenvoi agent ID + API key (provide them at step 4, not via env)

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

Replace `thenvoi-demo` with the sandbox name you chose at onboard:

```bash
nemoclaw thenvoi-demo policy-add --from-file ./presets/thenvoi.yaml
```

## 4. Configure the Thenvoi channel account

```bash
nemoclaw thenvoi-demo connect
```

Inside the sandbox shell, paste your actual Thenvoi credentials directly into the config (these stay inside the sandbox, never in env vars or the repo):

```bash
openclaw config set channels.openclaw-channel-thenvoi.accounts.primary.enabled true
openclaw config set channels.openclaw-channel-thenvoi.accounts.primary.apiKey  '<your-thenvoi-api-key>'
openclaw config set channels.openclaw-channel-thenvoi.accounts.primary.agentId '<your-thenvoi-agent-id>'
```

## 5. Start the agent

Still inside the sandbox shell:

```bash
openclaw agent --agent main
```

Watch for:

- `[thenvoi] Plugin loaded, channel registered`
- Phoenix Channels join activity

## 6. Verify (M1)

In the Thenvoi app, open a chat room with the agent and `@`-mention it. Expected: a Claude-generated reply appears in the room.

If nothing arrives, OpenShell's TUI will surface any blocked-egress prompts for operator approval — most likely candidate is the WSS upgrade to `app.thenvoi.com`.
