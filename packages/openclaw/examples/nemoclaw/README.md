# NemoClaw + Band

Policy preset for running the `@band-ai/openclaw-channel-band` channel plugin inside a
NemoClaw sandbox.

Full, maintained setup instructions live in the
[NemoClaw integration guide](https://docs.band.ai/integrations/sandboxes/nemoclaw) — this
directory holds only the artifact that guide fetches. Don't onboard from a Dockerfile here:
NemoClaw's stock image already contains the managed startup runtime, and the guide installs
the plugin into it after onboarding instead.

## Contents

- `presets/band.yaml` — the OpenShell egress policy preset that grants the sandbox REST and
  Phoenix Channels WebSocket access to `app.band.ai`. Apply it with:

  ```bash
  nemoclaw <sandbox-name> policy add --from-file ./presets/band.yaml --yes
  ```

  Band serves REST and the Phoenix Channels WebSocket upgrade on the same host and port, so
  the preset grants full TLS access to `app.band.ai:443` rather than a REST-only rule set;
  OpenShell rejects a REST-scoped rule and a full-access rule for the same endpoint as
  ambiguous. Access is limited to the sandbox's `node` binaries.
