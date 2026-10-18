import { afterEach, describe, expect, it, vi } from "vitest";
import { activityPeer, json } from "./support/activityPeer";
import { createDeferred } from "../src/core/deferred";

afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

describe("activity detail generated HTTP boundary", () => {
  it("shares one origin discovery, serializes detail in the body, and omits it on false", async () => {
    vi.resetModules();
    const { BandLink } = await import("../src/platform/BandLink");
    await using peer = await activityPeer(({ request, response, body }) => {
      json(response, request.url === "/api/version" ? { agent_version: "1.25.0" } : { data: { working: body.working } });
    });
    const first = new BandLink({ ...peer.linkOptions, wsUrl: "wss://unrelated.example/socket" });
    const second = new BandLink(peer.linkOptions);
    await Promise.all([
      first.reportActivity("a", true, { activity: { kind: "tool_call", name: "lookup" }, headers: { "x-custom": "retained" } }),
      second.reportActivity("b", true, { activity: { kind: "reasoning" } }),
    ]);
    await first.reportActivity("a", false, { activity: { kind: "memory" } });
    expect(peer.requests.entries.filter(({ request }) => request.url === "/api/version")).toHaveLength(1);
    const posts = peer.requests.entries.filter(({ request }) => request.method === "POST");
    expect(posts.map(({ body }) => body)).toEqual(expect.arrayContaining([
      { working: true, activity: { kind: "tool_call", name: "lookup" } },
      { working: true, activity: { kind: "reasoning" } }, { working: false },
    ]));
    expect(posts.find(({ body }) => (body.activity as { name?: string } | undefined)?.name === "lookup")!.request.headers["x-custom"]).toBe("retained");
    expect(posts.every(({ request }) => request.headers.activity === undefined)).toBe(true);
  });

  it("keeps legacy injected clients and false-only calls discovery-free", async () => {
    vi.resetModules();
    const { BandLink } = await import("../src/platform/BandLink");
    await using peer = await activityPeer(({ response, body }) => json(response, { data: { working: body.working } }));
    const { restUrl: _origin, ...legacy } = peer.linkOptions;
    await new BandLink(legacy).reportActivity("room", true, { activity: { kind: "memory" } });
    await new BandLink(peer.linkOptions).reportActivity("room", false, { activity: { kind: "reasoning" } });
    expect(peer.requests.entries.map(({ body }) => body)).toEqual([{ working: true }, { working: false }]);
  });

  it.each([true, false])("latches before one boolean retry for a detail 422 (JSON: %s)", async (isJson) => {
    vi.resetModules();
    const { BandLink } = await import("../src/platform/BandLink");
    await using peer = await activityPeer(({ request, response, body }) => {
      if (request.url === "/api/version") return json(response, { agent_version: "1.25.0" });
      if (body.activity) {
        if (isJson) json(response, { error: "unsupported" }, 422);
        else { response.writeHead(422, { "Content-Type": "text/plain" }); response.end("unsupported"); }
      } else json(response, { data: { working: body.working } });
    });
    const link = new BandLink(peer.linkOptions);
    await link.reportActivity("a", true, { activity: { kind: "reasoning" } });
    await new BandLink(peer.linkOptions).reportActivity("b", true, { activity: { kind: "memory" } });
    expect(peer.requests.entries.filter(({ request }) => request.method === "POST").map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true }, { working: true },
    ]);
  });

  it.each([401, 404, 503, 422])("never retries a boolean %s or downgrades for an unrelated failure", async (status) => {
    vi.resetModules();
    const { BandLink } = await import("../src/platform/BandLink");
    let failed = false;
    await using peer = await activityPeer(({ request, response, body }) => {
      if (request.url === "/api/version") return json(response, { agent_version: "1.25.0" });
      if (!failed) { failed = true; return json(response, { error: "failure" }, status); }
      json(response, { data: { working: body.working } });
    });
    const link = new BandLink(peer.linkOptions);
    await expect(link.reportActivity("a", true, { maxRetries: 0 })).rejects.toMatchObject({ statusCode: status });
    await link.reportActivity("b", true, { activity: { kind: "memory" } });
    expect(peer.requests.entries.filter(({ request }) => request.method === "POST").map(({ body }) => body)).toEqual([
      { working: true }, { working: true, activity: { kind: "memory" } },
    ]);
  });

  it.each([401, 404, 503])("does not retry or downgrade a detail-bearing %s", async (status) => {
    vi.resetModules();
    const { BandLink } = await import("../src/platform/BandLink");
    let posts = 0;
    await using peer = await activityPeer(({ request, response, body }) => {
      if (request.url === "/api/version") return json(response, { agent_version: "1.25.0" });
      if (++posts === 1) return json(response, { error: "failure" }, status);
      json(response, { data: { working: body.working } });
    });
    const link = new BandLink(peer.linkOptions);
    await expect(link.reportActivity("a", true, { activity: { kind: "reasoning" } })).rejects.toMatchObject({ statusCode: status });
    await link.reportActivity("b", true, { activity: { kind: "memory" } });
    expect(peer.requests.entries.filter(({ request }) => request.method === "POST").map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true, activity: { kind: "memory" } },
    ]);
  });

  it("strips detail from another link while the downgraded request's boolean retry is held", async () => {
    vi.resetModules();
    const { BandLink } = await import("../src/platform/BandLink");
    const retrying = createDeferred();
    await using peer = await activityPeer(({ request, response, body }) => {
      if (request.url === "/api/version") return json(response, { agent_version: "1.25.0" });
      if (body.activity) return json(response, { error: "unsupported" }, 422);
      if (request.url?.includes("/a/")) { retrying.resolve(); return; }
      json(response, { data: { working: body.working } });
    });
    const first = new BandLink(peer.linkOptions).reportActivity("a", true, { activity: { kind: "reasoning" } });
    await retrying.promise;
    await new BandLink(peer.linkOptions).reportActivity("b", true, { activity: { kind: "memory" } });
    const posts = peer.requests.entries.filter(({ request }) => request.method === "POST");
    expect(posts.map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true }, { working: true },
    ]);
    json(posts[1]!.response, { data: { working: true } });
    await first;
  });

  it("reserves the original deadline across discovery and a stalled fallback body", async () => {
    vi.resetModules();
    const { BandLink } = await import("../src/platform/BandLink");
    const discovered = createDeferred();
    const fallback = createDeferred();
    const closed = createDeferred();
    await using peer = await activityPeer(({ request, response, body }) => {
      if (request.url === "/api/version") { discovered.resolve(); return; }
      if (body.activity) return json(response, { error: "unsupported" }, 422);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"data":');
      response.on("close", () => closed.resolve());
      fallback.resolve();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const report = new BandLink(peer.linkOptions).reportActivity("room", true, { activity: { kind: "reasoning" }, timeoutInSeconds: 2 });
    const rejected = expect(report).rejects.toBeDefined();
    await discovered.promise;
    await vi.advanceTimersByTimeAsync(800);
    json(peer.requests.entries[0]!.response, { agent_version: "1.25.0" });
    await fallback.promise;
    await vi.advanceTimersByTimeAsync(1200);
    await rejected;
    await closed.promise;
    expect(peer.requests.entries.filter(({ request }) => request.method === "POST").map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true },
    ]);
  });
});
