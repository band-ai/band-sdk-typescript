import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityCompatibility } from "../src/platform/activityCompatibility";
import { NoopLogger } from "../src/core/logger";
import { activityPeer, json } from "./support/activityPeer";
import { createDeferred } from "../src/core/deferred";

const nullLogger = new NoopLogger();

afterEach(() => vi.useRealTimers());

describe("activity discovery", () => {
  it.each([
    [{ agent_version: "1.25.0" }, true], [{ agent_version: "2.0.0" }, true],
    [{ agent_version: "1.24.99" }, false], [{ agent_version: "1.25.0-beta.1" }, false],
    [{ agent_version: "1.25" }, false], [{ agent_version: null }, false],
    [{ agent_version: "01.25.0" }, false], [{ agent_version: "1.025.0" }, false],
    [{ agent_version: "1.25.00" }, false], [{ agent_version: "1.25.0+build" }, false],
    [{ version: "9.0.0", platform_version: "9.0.0" }, false],
  ])("uses only an ordinary agent_version release: %j", async (version, expected) => {
    await using peer = await activityPeer(({ response, request }) => {
      expect(request.url).toBe("/api/version");
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-api-key"]).toBeUndefined();
      json(response, version);
    });
    const compatibility = new ActivityCompatibility();
    expect(await compatibility.available(peer.origin, 2000, new AbortController().signal, nullLogger)).toBe(expected);
    expect(await compatibility.available("http://unused.test", 2000, new AbortController().signal, nullLogger)).toBe(expected);
    expect(peer.requests.entries).toHaveLength(1);
  });

  it("bounds a waiter without cancelling shared discovery and permanently latches downgrade", async () => {
    const accepted = createDeferred();
    await using peer = await activityPeer(() => accepted.resolve());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const compatibility = new ActivityCompatibility();
    const owner = compatibility.available(peer.origin, 2000, new AbortController().signal, nullLogger);
    await accepted.promise;
    const waiter = compatibility.available(peer.origin, 200, new AbortController().signal, nullLogger);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiter).toBe(false);
    expect(peer.requests.entries[0]!.response.destroyed).toBe(false);
    json(peer.requests.entries[0]!.response, { agent_version: "1.25.0" });
    expect(await owner).toBe(true);
    compatibility.downgrade(nullLogger);
    expect(await compatibility.available(peer.origin, 2000, new AbortController().signal, nullLogger)).toBe(false);
    expect(peer.requests.entries).toHaveLength(1);
  });

  it.each([401, 404, 500, 200])("caches failed or malformed discovery (%s) without forwarding auth", async (status) => {
    await using peer = await activityPeer(({ response }) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(status === 200 ? "not json" : JSON.stringify({ agent_version: "9.0.0" }));
    });
    const compatibility = new ActivityCompatibility();
    const signal = new AbortController().signal;
    expect(await compatibility.available(peer.origin, 2000, signal, nullLogger)).toBe(false);
    expect(await compatibility.available(peer.origin, 2000, signal, nullLogger)).toBe(false);
    expect(peer.requests.entries).toHaveLength(1);
  });

  it.each(["owner", "waiter"])("cancels the %s's wait without cancelling discovery for another link", async (cancelled) => {
    const accepted = createDeferred();
    await using peer = await activityPeer(() => accepted.resolve());
    const compatibility = new ActivityCompatibility();
    const ownerSignal = new AbortController();
    const waiterSignal = new AbortController();
    const owner = compatibility.available(peer.origin, 2000, ownerSignal.signal, nullLogger);
    await accepted.promise;
    const waiter = compatibility.available(peer.origin, 2000, waiterSignal.signal, nullLogger);
    (cancelled === "owner" ? ownerSignal : waiterSignal).abort();
    expect(await (cancelled === "owner" ? owner : waiter)).toBe(false);
    expect(peer.requests.entries[0]!.response.destroyed).toBe(false);
    json(peer.requests.entries[0]!.response, { agent_version: "1.25.0" });
    expect(await (cancelled === "owner" ? waiter : owner)).toBe(true);
    expect(peer.requests.entries).toHaveLength(1);
  });

  it("aborts stalled discovery body and caches the unavailable result", async () => {
    const accepted = createDeferred();
    const closed = createDeferred();
    await using peer = await activityPeer(({ response }) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"agent_version":');
      response.on("close", () => closed.resolve());
      accepted.resolve();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const compatibility = new ActivityCompatibility();
    const lookup = compatibility.available(peer.origin, 2000, new AbortController().signal, nullLogger);
    await accepted.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await lookup).toBe(false);
    await closed.promise;
    expect(await compatibility.available(peer.origin, 2000, new AbortController().signal, nullLogger)).toBe(false);
    expect(peer.requests.entries).toHaveLength(1);
  });
});
