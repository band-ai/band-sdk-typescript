import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityCapability } from "../src/client/rest/activityCapability";
import { createDeferred } from "../src/core/deferred";
import { activityPeer, json } from "./support/activityPeer";

afterEach(() => vi.useRealTimers());

const health = (apiVersion: unknown) => ({ status: "ok", version: "0.36.0", api_version: apiVersion });

describe("activity capability lookup", () => {
  it.each([
    [{ api_version: "1.25.0" }, "supported"], [{ api_version: "2.0.0" }, "supported"],
    [{ api_version: "1.24.99" }, "unsupported"], [{ api_version: "1.25.0-beta.1" }, "unsupported"],
    [{ api_version: "1.25" }, "unsupported"], [{ api_version: null }, "unsupported"],
    [{ api_version: "01.25.0" }, "unsupported"], [{ api_version: "1.025.0" }, "unsupported"],
    [{ api_version: "1.25.0+build" }, "unsupported"],
    [{ agent_version: "9.0.0", version: "9.0.0" }, "unsupported"],
  ])("decides from the ordinary api_version release only: %j", async (body, expected) => {
    await using peer = await activityPeer(({ response }) => json(response, body));
    const capability = new ActivityCapability({ origin: peer.origin });
    expect(await capability.lookup()).toBe(expected);
    expect(await capability.lookup()).toBe(expected);
    const [{ request }] = peer.requests.entries;
    expect(peer.requests.entries).toHaveLength(1);
    expect(request.url).toBe("/api/v1/health");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-api-key"]).toBeUndefined();
  });

  it("finds support on a gateway host that serves HTML at /api/version", async () => {
    await using peer = await activityPeer(({ request, response }) => {
      if (request.url === "/api/v1/health") return json(response, health("1.26.1"));
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!DOCTYPE html><html></html>");
    });
    expect(await new ActivityCapability({ origin: peer.origin }).lookup()).toBe("supported");
    expect(peer.requests.entries.map(({ request }) => request.url)).toEqual(["/api/v1/health"]);
  });

  it.each([401, 404, 400])("treats HTTP %s as a final answer", async (status) => {
    await using peer = await activityPeer(({ response }) => json(response, { api_version: "9.0.0" }, status));
    const capability = new ActivityCapability({ origin: peer.origin });
    expect(await capability.lookup()).toBe("unsupported");
    expect(await capability.lookup()).toBe("unsupported");
    expect(peer.requests.entries).toHaveLength(1);
  });

  it.each(["not json", "<!DOCTYPE html>"])("treats a non-JSON answer (%s) as final", async (text) => {
    await using peer = await activityPeer(({ response }) => void response.end(text));
    const capability = new ActivityCapability({ origin: peer.origin });
    expect(await capability.lookup()).toBe("unsupported");
    expect(await capability.lookup()).toBe("unsupported");
    expect(peer.requests.entries).toHaveLength(1);
  });

  it.each([500, 503, 429])("leaves the answer unknown after HTTP %s and asks again later", async (status) => {
    let healthy = false;
    await using peer = await activityPeer(({ response }) => healthy ? json(response, health("1.26.1")) : json(response, { error: "busy" }, status));
    const capability = new ActivityCapability({ origin: peer.origin });
    expect(await capability.lookup()).toBe("unknown");
    expect(await capability.lookup()).toBe("unknown");
    expect(peer.requests.entries).toHaveLength(2);
    healthy = true;
    expect(await capability.lookup()).toBe("supported");
    expect(await capability.lookup()).toBe("supported");
    expect(peer.requests.entries).toHaveLength(3);
  });

  it("logs a failure streak once and its resolution once", async () => {
    let healthy = false;
    await using peer = await activityPeer(({ response }) => healthy ? json(response, health("1.26.1")) : json(response, { error: "busy" }, 503));
    const debug = vi.fn();
    const capability = new ActivityCapability({ origin: peer.origin, logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    await capability.lookup();
    await capability.lookup();
    await capability.lookup();
    healthy = true;
    await capability.lookup();
    expect(debug.mock.calls.map(([message]) => message)).toEqual([
      "Activity detail support lookup failed; the next report asks again",
      "Activity detail support resolved",
    ]);
  });

  it("leaves the answer unknown when nothing is listening", async () => {
    const peer = await activityPeer(() => undefined);
    const origin = peer.origin;
    await peer[Symbol.asyncDispose]();
    const capability = new ActivityCapability({ origin });
    expect(await capability.lookup()).toBe("unknown");
  });

  it("shares one request among concurrent callers and never makes a caller wait", async () => {
    const accepted = createDeferred();
    await using peer = await activityPeer(() => accepted.resolve());
    const capability = new ActivityCapability({ origin: peer.origin });
    const first = capability.lookup();
    const second = capability.lookup();
    expect(capability.allowsDetail()).toBe(false);
    await accepted.promise;
    expect(peer.requests.entries).toHaveLength(1);
    json(peer.requests.entries[0]!.response, health("1.25.0"));
    expect(await Promise.all([first, second])).toEqual(["supported", "supported"]);
    expect(capability.allowsDetail()).toBe(true);
    expect(peer.requests.entries).toHaveLength(1);
  });

  it("aborts a stalled lookup at its own timeout, then asks again on a later report", async () => {
    const stalled = createDeferred();
    const closed = createDeferred();
    let stall = true;
    await using peer = await activityPeer(({ response }) => {
      if (!stall) return json(response, health("1.26.1"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"api_version":');
      response.on("close", () => closed.resolve());
      stalled.resolve();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const capability = new ActivityCapability({ origin: peer.origin });
    const lookup = capability.lookup(2);
    await stalled.promise;
    await vi.advanceTimersByTimeAsync(2000);
    expect(await lookup).toBe("unknown");
    await closed.promise;
    stall = false;
    expect(await capability.lookup(2)).toBe("supported");
  });

  it("becomes unsupported when the platform rejects detail after a supported answer", async () => {
    await using peer = await activityPeer(({ response }) => json(response, health("1.26.1")));
    const capability = new ActivityCapability({ origin: peer.origin });
    expect(await capability.lookup()).toBe("supported");
    capability.markUnsupported();
    expect(capability.allowsDetail()).toBe(false);
    expect(await capability.lookup()).toBe("unsupported");
    expect(peer.requests.entries).toHaveLength(1);
  });

  it("stays unsupported once the platform rejected detail, even if a lookup was in flight", async () => {
    const accepted = createDeferred();
    await using peer = await activityPeer(() => accepted.resolve());
    const capability = new ActivityCapability({ origin: peer.origin });
    const lookup = capability.lookup();
    await accepted.promise;
    capability.markUnsupported();
    json(peer.requests.entries[0]!.response, health("1.26.1"));
    expect(await lookup).toBe("unsupported");
    expect(capability.allowsDetail()).toBe(false);
    expect(peer.requests.entries).toHaveLength(1);
  });
});
