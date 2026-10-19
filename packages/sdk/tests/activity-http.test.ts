import { BandClient } from "@band-ai/rest-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { BandLink } from "../src/platform/BandLink";
import { createDeferred } from "../src/core/deferred";
import { activityPeer, json, type ActivityRequest } from "./support/activityPeer";
import { FakeTransport } from "./testUtils";

afterEach(() => vi.useRealTimers());

const HEALTH = "/api/v1/health";
const posts = (requests: readonly ActivityRequest[]) => requests.filter(({ request }) => request.method === "POST");
const echoWorking = ({ response, body }: ActivityRequest) => json(response, { data: { working: body.working } });

/** A platform that supports detail and answers the capability lookup immediately. */
const supportingPeer = () => activityPeer((entry) => {
  if (entry.request.url === HEALTH) return json(entry.response, { api_version: "1.25.0" });
  echoWorking(entry);
});

describe("activity detail generated HTTP boundary", () => {
  it("sends boolean-only while the lookup is held, then detail once it resolves", async () => {
    await using peer = await activityPeer((entry) => {
      if (entry.request.url !== HEALTH) echoWorking(entry);
    });
    await peer.rest.reportActivity("a", true, { activity: { kind: "reasoning" } });
    const lookup = await peer.requests.next(({ request }) => request.url === HEALTH);
    expect(posts(peer.requests.entries).map(({ body }) => body)).toEqual([{ working: true }]);

    json(lookup.response, { api_version: "1.26.1" });
    await peer.capability.lookup();
    await peer.rest.reportActivity("a", true, { activity: { kind: "tool_call", name: "lookup" }, headers: { "x-custom": "retained" } });

    const sent = posts(peer.requests.entries);
    expect(sent[1]!.body).toEqual({ working: true, activity: { kind: "tool_call", name: "lookup" } });
    expect(sent[1]!.request.headers["x-custom"]).toBe("retained");
  });

  it("omits detail on false and never looks the version up for it", async () => {
    await using peer = await supportingPeer();
    await peer.rest.reportActivity("a", false, { activity: { kind: "memory" } });
    expect(peer.requests.entries.map(({ body }) => body)).toEqual([{ working: false }]);
  });

  it("keeps an adapter without a capability boolean-only and lookup-free", async () => {
    await using peer = await supportingPeer();
    const plain = new FernRestAdapter(new BandClient({ apiKey: "secret-test-key", baseUrl: peer.origin }));
    await plain.reportActivity("a", true, { activity: { kind: "memory" } });
    expect(peer.requests.entries.map(({ body }) => body)).toEqual([{ working: true }]);
  });

  it("looks the version up through the REST base URL a gateway host serves, from a default-built link", async () => {
    await using peer = await activityPeer((entry) => {
      if (entry.request.url === HEALTH) return json(entry.response, { api_version: "1.26.1" });
      if (entry.request.url === "/api/version") {
        entry.response.writeHead(200, { "Content-Type": "text/html" });
        return void entry.response.end("<!DOCTYPE html><html></html>");
      }
      echoWorking(entry);
    });
    const link = new BandLink({ agentId: "agent", apiKey: "secret-test-key", restUrl: peer.origin, transport: new FakeTransport() });
    await link.reportActivity("room", true, { activity: { kind: "reasoning" } });
    const lookup = await peer.requests.next(({ request }) => request.method === "GET");
    expect(lookup.request.url).toBe(HEALTH);
  });

  it.each([true, false])("stops sending detail before one boolean resend after a detail 422 (JSON: %s)", async (isJson) => {
    await using peer = await activityPeer((entry) => {
      if (entry.request.url === HEALTH) return json(entry.response, { api_version: "1.25.0" });
      if (!entry.body.activity) return echoWorking(entry);
      if (isJson) return json(entry.response, { error: "unsupported" }, 422);
      entry.response.writeHead(422, { "Content-Type": "text/plain" });
      entry.response.end("unsupported");
    });
    await peer.capability.lookup();
    await peer.rest.reportActivity("a", true, { activity: { kind: "reasoning" } });
    await peer.rest.reportActivity("b", true, { activity: { kind: "memory" } });
    expect(posts(peer.requests.entries).map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true }, { working: true },
    ]);
    expect(await peer.capability.lookup()).toBe("unsupported");
  });

  it("strips detail from another room while the boolean resend is held", async () => {
    const retrying = createDeferred();
    await using peer = await activityPeer((entry) => {
      if (entry.request.url === HEALTH) return json(entry.response, { api_version: "1.25.0" });
      if (entry.body.activity) return json(entry.response, { error: "unsupported" }, 422);
      if (entry.request.url?.includes("/a/")) return retrying.resolve();
      echoWorking(entry);
    });
    await peer.capability.lookup();
    const first = peer.rest.reportActivity("a", true, { activity: { kind: "reasoning" } });
    await retrying.promise;
    await peer.rest.reportActivity("b", true, { activity: { kind: "memory" } });
    const sent = posts(peer.requests.entries);
    expect(sent.map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true }, { working: true },
    ]);
    json(sent[1]!.response, { data: { working: true } });
    await first;
  });

  it.each([401, 404, 503])("does not retry or stop detail after a detail-bearing %s", async (status) => {
    let failed = false;
    await using peer = await activityPeer((entry) => {
      if (entry.request.url === HEALTH) return json(entry.response, { api_version: "1.25.0" });
      if (!failed) { failed = true; return json(entry.response, { error: "failure" }, status); }
      echoWorking(entry);
    });
    await peer.capability.lookup();
    await expect(peer.rest.reportActivity("a", true, { activity: { kind: "reasoning" }, maxRetries: 0 })).rejects.toMatchObject({ statusCode: status });
    await peer.rest.reportActivity("b", true, { activity: { kind: "memory" } });
    expect(posts(peer.requests.entries).map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true, activity: { kind: "memory" } },
    ]);
  });

  it("neither retries nor stops detail after a boolean 422", async () => {
    let failed = false;
    await using peer = await activityPeer((entry) => {
      if (entry.request.url === HEALTH) return json(entry.response, { api_version: "1.25.0" });
      if (!failed) { failed = true; return json(entry.response, { error: "invalid" }, 422); }
      echoWorking(entry);
    });
    await peer.capability.lookup();
    await expect(peer.rest.reportActivity("a", true, { maxRetries: 0 })).rejects.toMatchObject({ statusCode: 422 });
    await peer.rest.reportActivity("b", true, { activity: { kind: "memory" } });
    expect(posts(peer.requests.entries).map(({ body }) => body)).toEqual([
      { working: true }, { working: true, activity: { kind: "memory" } },
    ]);
  });

  it("bounds the detail attempt and its boolean resend with the caller's one signal", async () => {
    const stalled = createDeferred();
    const closed = createDeferred();
    await using peer = await activityPeer((entry) => {
      if (entry.request.url === HEALTH) return json(entry.response, { api_version: "1.25.0" });
      if (entry.body.activity) return json(entry.response, { error: "unsupported" }, 422);
      entry.response.writeHead(200, { "Content-Type": "application/json" });
      entry.response.write('{"data":');
      entry.response.on("close", () => closed.resolve());
      stalled.resolve();
    });
    await peer.capability.lookup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), 2000);
    const report = peer.rest.reportActivity("room", true, { activity: { kind: "reasoning" }, maxRetries: 0, abortSignal: deadline.signal });
    const rejected = expect(report).rejects.toBeDefined();
    await stalled.promise;
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    await closed.promise;
    expect(posts(peer.requests.entries).map(({ body }) => body)).toEqual([
      { working: true, activity: { kind: "reasoning" } }, { working: true },
    ]);
  });
});
