# NemoClaw + Band

Run the Band channel plugin in NemoClaw's stock OpenClaw runtime on Apple Silicon macOS. This flow is verified with NemoClaw `0.0.124`, OpenShell `0.0.116`, and the Anthropic provider. Commands labeled **host** run in your macOS terminal. Commands labeled **sandbox** run only after `nemoclaw band-demo connect`.

Band credentials are stored in `/sandbox/.openclaw/openclaw.json`. They are not stored in host environment variables or this repository.

## Prerequisites

- Apple Silicon Mac
- Docker Desktop or Colima running
- Xcode Command Line Tools
- Anthropic API key
- Band agent ID and agent API key

Install the Xcode Command Line Tools if needed:

**Host**

```bash
xcode-select --install
```

## 1. Install NemoClaw

**Host**

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

Open a new terminal window or tab so `nemoclaw` is on `PATH`. To continue in the current terminal instead, run the command for your shell.

For zsh:

```zsh
. "$HOME/.zshrc"
```

For bash:

```bash
if [[ -f "$HOME/.bashrc" ]]; then . "$HOME/.bashrc"; else . "$HOME/.bash_profile"; fi
```

For fish:

```fish
source "$HOME/.config/fish/config.fish"
```

## 2. Check the container runtime

Verify the active runtime and NemoClaw's platform detection before onboarding.

**Host**

```bash
docker info --format '{{.OperatingSystem}}'
nemoclaw host probe
```

Continue only when Docker identifies Docker Desktop or Colima and the host probe succeeds. NemoClaw `0.0.124` rejects OrbStack on macOS even when `docker info` succeeds.

After switching from OrbStack to Colima, inspect the default Docker socket:

**Host**

```bash
readlink /var/run/docker.sock
```

If that socket still points to OrbStack, bind NemoClaw and its managed gateway to Colima in the terminal you will use for the remaining host commands:

**Host**

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
```

## 3. Onboard the stock OpenClaw runtime

**Host**

```bash
nemoclaw onboard --name band-demo
```

Choose the following options in the wizard:

1. Select **OpenClaw** as the agent.
2. Select **Anthropic** as the inference provider.
3. Provide or confirm the Anthropic API key.
4. Decline web search and the bundled messaging channels unless you need them.
5. Use the default OpenShell resource profile.

Do not pass this example's base-only Dockerfile with `--from`. NemoClaw `0.0.124` treats a custom Dockerfile as the complete sandbox image. The base image does not contain the managed startup runtime, so its gateway cannot become ready. Onboard the stock runtime and install the Band plugin after the sandbox is ready.

## 4. Apply the Band egress policy

Create and apply the policy from the same host terminal:

**Host**

```bash
cat > band-policy.yaml <<'YAML'
preset:
  name: band
  description: "Band REST API and Phoenix Channels WebSocket access"

network_policies:
  band:
    name: band
    endpoints:
      - host: app.band.ai
        port: 443
        access: full
        tls: skip
    binaries:
      - path: /usr/local/bin/node
      - path: /usr/bin/node
YAML

nemoclaw band-demo policy-add --from-file ./band-policy.yaml
```

Band uses REST and a Phoenix Channels WebSocket on the same host and port. One host-scoped full TLS endpoint permits both protocols while limiting access to the Node binaries. OpenShell rejects separate REST and full-access rules for `app.band.ai:443` as ambiguous.

## 5. Install the Band plugin

Install the pinned plugin into the stock runtime, then connect to the sandbox:

**Host**

```bash
nemoclaw band-demo exec -- env HOME=/sandbox openclaw plugins install @band-ai/openclaw-channel-band@0.2.1 --force
nemoclaw band-demo connect
```

The shell opened by `connect` is inside the sandbox. Run the rest of this section there.

The published plugin version `0.2.1` omits its required WebAssembly asset. Repair it with the matching asset from `@band-ai/band-sdk-core@2.0.0`:

**Sandbox**

```bash
plugin_dir="$(
  openclaw plugins inspect openclaw-channel-band --json |
    node -e '
      const input = require("node:fs").readFileSync(0, "utf8");
      const json = input.slice(input.indexOf("{"));
      process.stdout.write(JSON.parse(json).plugin.rootDir);
    '
)"
tmp_dir="$(mktemp -d)"
archive="$(npm pack @band-ai/band-sdk-core@2.0.0 --pack-destination "$tmp_dir" --silent)"
tar -xOf "$tmp_dir/$archive" package/band_sdk_core_bg.wasm > "$plugin_dir/dist/band_sdk_core_bg.wasm"
rm -rf "$tmp_dir"

openclaw plugins inspect openclaw-channel-band --runtime --json
```

The Node parser discards any proxy status line before the JSON. The final inspection must report `"status": "loaded"` and an empty `diagnostics` array. Reinstall and repair the plugin after a NemoClaw rebuild that replaces the sandbox's writable OpenClaw state.

## 6. Configure Band inside the sandbox

NemoClaw's host-side `channels add` command rejects custom channels, and its sandbox wrapper blocks `openclaw channels add`. Use persistent `openclaw config set` commands instead.

The following prompts keep the API key out of shell history:

**Sandbox**

```bash
read -r -p "Band agent ID: " BAND_AGENT_ID
read -r -s -p "Band agent API key: " BAND_API_KEY
echo

openclaw config set channels.openclaw-channel-band.enabled true --strict-json
openclaw config set channels.openclaw-channel-band.accounts.default.enabled true --strict-json
openclaw config set channels.openclaw-channel-band.accounts.default.agentId "$BAND_AGENT_ID"
openclaw config set channels.openclaw-channel-band.accounts.default.apiKey "$BAND_API_KEY"
openclaw config set tools.alsoAllow '["bundle-mcp","openclaw-channel-band","message"]' --strict-json
unset BAND_AGENT_ID BAND_API_KEY
```

The settings persist in `/sandbox/.openclaw/openclaw.json`. The tool allowlist retains NemoClaw's `bundle-mcp` tool and exposes the Band channel and `message` tools.

Leave the sandbox:

**Sandbox**

```bash
exit
```

Back in the host terminal, restart the managed gateway and follow its logs:

**Host**

```bash
nemoclaw band-demo gateway restart
nemoclaw band-demo logs --follow
```

A successful connection emits:

```text
[band:default] connected to Band
```

## 7. Verify from Band

Add the agent to a Band room and mention it. A model-generated reply should appear in the same room.

## Troubleshooting

| Symptom | Action |
|---|---|
| NemoClaw rejects the host platform or container runtime | Run `docker info --format '{{.OperatingSystem}}'`. Start Docker Desktop or Colima, switch to its Docker context, and confirm `nemoclaw host probe` succeeds. OrbStack is unsupported. |
| A Docker volume is missing after switching runtimes | Run `readlink /var/run/docker.sock`. If it points to the old runtime, stop the existing gateway after confirming it has no running sandboxes, export Colima's `DOCKER_HOST`, and onboard a new `band-demo` sandbox. |
| A custom image is created but its gateway never becomes ready | The example Dockerfile is only a base image. Onboard the stock runtime without a custom image, then install the plugin in the ready sandbox. |
| The plugin does not load | Inside the sandbox, run `openclaw plugins inspect openclaw-channel-band --runtime --json`. If version `0.2.1` reports a missing `band_sdk_core_bg.wasm`, repeat the repair in step 5. |
| `[band:default] connected to Band` never appears | Confirm the default account is enabled, the agent ID and API key match, and the `band-policy.yaml` policy is applied. Check OpenShell policy prompts for blocked access to `app.band.ai:443`. |
| Band tools are hidden | Set `tools.alsoAllow` to `["bundle-mcp","openclaw-channel-band","message"]`, restart the gateway, and start a new Band conversation. |
