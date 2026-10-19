import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import { createDeferred } from "../../../src/core/deferred";

/** Hold real adapter entry/return so each semantic state can reach the observer. */
export function activityPhases() {
  const entered = createDeferred();
  const enter = createDeferred();
  const returned = createDeferred();
  const finish = createDeferred();
  const stopped = new AbortController();
  const release = () => { stopped.abort(); enter.resolve(); finish.resolve(); };
  onTestFinished(release);
  return {
    entered: entered.promise, returned: returned.promise,
    enter: () => enter.resolve(), finish: () => finish.resolve(),
    release,
    wrap(adapter: FrameworkAdapter, prepare?: () => Promise<void>): FrameworkAdapter {
      return {
        onStarted: async (name, description) => { await prepare?.(); await adapter.onStarted(name, description); },
        onEvent: async (input) => {
          entered.resolve();
          await enter.promise;
          if (stopped.signal.aborted) return;
          try { await adapter.onEvent(input); }
          finally { returned.resolve(); await finish.promise; }
        },
        onCleanup: async (roomId) => { release(); await adapter.onCleanup(roomId); },
        onRuntimeStop: async () => { release(); await adapter.onRuntimeStop?.(); },
      };
    },
  };
}

const ACTIVITY_MARKER_HEADER = "x-activity-marker";
const BARRIER_HELPER = fileURLToPath(new URL("./activityBarrier.mjs", import.meta.url));

/** Native Bash runs this Node helper and waits for an explicit harness response. */
export async function nativeToolBarrier(workDir: string, marker: string) {
  const entered = createDeferred<string>();
  const release = createDeferred();
  const server = createServer(async (request, response) => {
    entered.resolve(String(request.headers[ACTIVITY_MARKER_HEADER] ?? ""));
    await release.promise;
    response.end("released");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No native activity barrier port");
  onTestFinished(async () => {
    release.resolve();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const path = join(workDir, "activity-barrier.mjs");
  await copyFile(BARRIER_HELPER, path);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    command: `node ${quote(path)} http://127.0.0.1:${address.port}/ready ${ACTIVITY_MARKER_HEADER} ${quote(marker)}`,
    entered: entered.promise,
    release: () => release.resolve(),
  };
}
