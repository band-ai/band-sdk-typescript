# Band Linear PM

This example runs the Band Linear PM agent — the Linear-facing coordinator that:

1. Linear sends an `AgentSessionEvent` webhook to `/linear/webhook`
2. the server resolves or reuses a Thenvoi room for that issue
3. Band Linear PM coordinates real Thenvoi specialists in that room
4. progress and the final response are written back to Linear

Band Linear PM is the only Linear-aware participant. Planner, reviewer, and coder agents stay Linear-agnostic and communicate only through Thenvoi room messages.

The SQLite session-room mapping uses `node:sqlite`, so this example requires Node.js 22+.

## Files

- `examples/linear-thenvoi/linear-thenvoi-bridge-server.ts`
  Webhook server and embedded Band Linear PM runtime.
- `examples/linear-thenvoi/linear-thenvoi-bridge-agent.ts`
  Band Linear PM agent using the Codex adapter and Linear tools.

## Environment

Create a local `.env.local` from `.env.local.example`. The agent only needs a few real values:

```bash
LINEAR_ACCESS_TOKEN=lin_api_xxx
LINEAR_WEBHOOK_SECRET=lin_wh_xxx
THENVOI_API_KEY=thnv_a_xxx
THENVOI_REST_URL=https://app.thenvoi.com
```

Common optional settings:

```bash
LINEAR_THENVOI_STATE_DB=.linear-thenvoi-example.sqlite
LINEAR_THENVOI_ROOM_STRATEGY=issue
LINEAR_THENVOI_WRITEBACK_MODE=activity_stream
THENVOI_HOST_AGENT_HANDLE=your-org/linear-orchestrator
CODEX_MODEL=gpt-5.4-mini
PORT=8787
```

Recommended agent config key:

- `linear_thenvoi_bridge`

## Run

```bash
pnpm dev:linear
```

That starts the webhook server and the embedded Band Linear PM agent in one process.

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

If you need a public webhook URL for Linear, run your tunnel separately. Example with Cloudflare:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Then point the Linear webhook at:

```text
https://<your-tunnel-host>/linear/webhook
```

## Secrets

- `.env.local` is gitignored.
- `agent_config.yaml` is gitignored.
- `*.sqlite` files are gitignored.
- Do not commit real `LINEAR_ACCESS_TOKEN`, `LINEAR_WEBHOOK_SECRET`, or `THENVOI_API_KEY` values.

## Docker

Build from the repository root:

```bash
docker build -f packages/sdk/examples/linear-thenvoi/Dockerfile -t thenvoi-linear-bridge .
```

Run the container, passing the required environment variables:

```bash
docker run --env-file .env -p 8787:8787 thenvoi-linear-bridge
```

The SQLite state database is created inside the container at the path set by
`LINEAR_THENVOI_STATE_DB` (defaults to `.linear-thenvoi-example.sqlite`).
To persist it across container restarts, mount a volume:

```bash
docker run --env-file .env -p 8787:8787 \
  -v linear-bridge-data:/app/packages/sdk/data \
  -e LINEAR_THENVOI_STATE_DB=/app/packages/sdk/data/state.sqlite \
  thenvoi-linear-bridge
```

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

## Architecture Notes

- `roomStrategy: "issue"` keeps one Thenvoi room per Linear issue.
- `roomStrategy: "session"` creates a new Thenvoi room per Linear session.
- `writebackMode: "activity_stream"` posts intermediate Linear activity updates.
- `writebackMode: "final_only"` keeps writeback minimal until completion.
- Band Linear PM uses peer discovery and room context to pick relevant external specialists at runtime.
- For planning work, Band Linear PM sends the full issue context to the planner, ends its turn, and continues when specialist output appears.
