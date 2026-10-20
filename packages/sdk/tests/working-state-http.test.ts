import { createServer } from "node:http";
import { once } from "node:events";
import { BandClient } from "@band-ai/rest-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { RestFacade } from "../src/client/rest/RestFacade";
import { BandLink } from "../src/platform/BandLink";
import { WorkingStateReporter } from "../src/runtime/workingState";
import { parseSessionConfig } from "../src/runtime/types";
import { createDeferred } from "../src/core/deferred";
import { FakeTransport, RecordLog } from "./testUtils";
import { buildFakeRestAdapter } from "./support/fakeRestAdapter";

afterEach(() => vi.useRealTimers());

describe("working-state generated HTTP boundary", () => {
  it.each([undefined, 200, 503])("aborts a stalled request/body (%s) before dispatching final false", async (status) => {
    const accepted = createDeferred();
    const aborted = createDeferred();
    const headersReceived = createDeferred();
    const bodies: unknown[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      bodies.push(JSON.parse(body));
      if (bodies.length === 1) {
        response.on("close", () => aborted.resolve());
        if (status !== undefined) {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.write('{"data":');
        }
        accepted.resolve();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { working: false } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP port");
    try {
      const rest = new FernRestAdapter(new BandClient({
        apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}`,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          headersReceived.resolve();
          return response;
        },
      }));
      const link = new BandLink({ agentId: "agent", apiKey: "test", restApi: new RestFacade({ api: rest }), transport: new FakeTransport() });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const reporter = new WorkingStateReporter((working, options) => link.reportActivity("room", working, options), parseSessionConfig(), "room");
      const lease = reporter.open();
      await accepted.promise;
      if (status !== undefined) await headersReceived.promise;
      const closed = reporter.close();
      expect(bodies).toEqual([{ working: true }]);
      await vi.advanceTimersByTimeAsync(2000);
      await aborted.promise;
      await closed;
      await lease.ready;
      await lease.end();
      expect(bodies).toEqual([{ working: true }, { working: false }]);
      await vi.advanceTimersByTimeAsync(9000);
      expect(bodies).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([429, 503, 404])("uses one attempt for %s and recovers through the actual generated response", async (status) => {
    vi.useFakeTimers();
    const { rest, calls } = buildFakeRestAdapter([
      { status, body: { error: "unavailable" } },
      { status: 200, body: { data: { working: true } } },
      { status: 200, body: { data: { working: false } } },
    ]);
    const log = new RecordLog<string>();
    const logger = { debug: (message: string) => log.record(message), warn: (message: string) => log.record(message), info: (message: string) => log.record(message), error: vi.fn() };
    const link = new BandLink({ agentId: "agent", apiKey: "test", restApi: rest, transport: new FakeTransport() });
    const reporter = new WorkingStateReporter((working, options) => link.reportActivity("room", working, options), parseSessionConfig(), "room", logger);
    const lease = reporter.open();
    await lease.ready;
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    await lease.end();
    expect(calls).toHaveLength(3);
    expect(log.entries).toContain(status === 404 ? "Working-state execution state unavailable" : "Working-state reporting failed");
    if (status !== 404) expect(log.entries).toContain("Working-state reporting recovered");
  });
});
