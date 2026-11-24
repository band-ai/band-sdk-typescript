import { createServer, type Server } from "node:http";

import { ParticipantRoster } from "@band-ai/band-sdk-core";
import { BandClient } from "@band-ai/rest-client";

import { describe, expect, it } from "vitest";

import { NoopLogger } from "../src/core/logger";
import { DeliveryUnknownError } from "../src/core/deliveryFailedError";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { BandLink } from "../src/platform/BandLink";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { PublicationEngine } from "../src/runtime/journal/publication";
import { ROOM, generationIn, openRoom } from "./turnJournalSupport";
import { tmpRoot } from "./testUtils";

const API_KEY = "fixture-key";
const USER_ID = "user-1";
const OP_ID = "op-redirect-1";

interface Origin {
  server: Server;
  origin: string;
  /** Every POST this origin received. */
  posts: number;
  close: () => Promise<void>;
}

/**
 * The two-origin fixture: origin `a` answers every POST with `status` and a
 * `location` into origin `b`; origin `b` accepts. Each origin counts the POSTs
 * it itself receives, so a redirect that a client follows shows up on `b`
 * regardless of how the client's Fetch is built.
 */
async function fixture(status: 307 | 308): Promise<{ a: Origin; b: Origin }> {
  const make = (answer: (requestUrl: string) => { status: number; headers?: Record<string, string> }): Promise<Origin> =>
    new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          if (req.method === "POST") {
            origin.posts += 1;
          }
          const { status: answerStatus, headers } = answer(req.url ?? "/");
          res.writeHead(answerStatus, { "content-type": "application/json", ...headers });
          res.end('{"id":"posted-1","status":"ok"}');
        });
      });
      const origin: Origin = {
        server,
        origin: "",
        posts: 0,
        close: async () => {
          await new Promise<void>((closeResolve, closeReject) => server.close((error) => (error ? closeReject(error) : closeResolve())));
        },
      };
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "string" || address === null) return reject(new Error("the fixture origin never stood"));
        origin.origin = `http://127.0.0.1:${address.port}`;
        resolve(origin);
      });
    });

  const b = await make(() => ({ status: 201 }));
  const a = await make(() => ({ status, headers: { location: `${b.origin}/v1/chats/${ROOM}/messages` } }));
  return { a, b };
}

/** A Fetch that counts its own origin's traffic and refuses redirects, as the SDK's once client installs. */
function redirectErrorFetch(origin: Origin): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin.origin) {
      throw new Error(`the once client never addresses ${url.origin}`);
    }
    return fetch(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}

/**
 * The two-origin fixture, run through the real generated client: the once client's Fetch
 * refuses the redirect, so the initial POST to origin A lands exactly once and no second
 * POST ever reaches origin B; the legacy client's Fetch follows it, the double post the
 * keyed contract exists to prevent.
 */
describe.each([307, 308] as const)("a %i redirect from the post's origin", (status) => {
  it("posts once on the once port and nowhere else; the legacy port follows the redirect into a second origin", async () => {
    const { a, b } = await fixture(status);
    const legacyClient = new BandClient({ apiKey: API_KEY, baseUrl: a.origin, maxRetries: 0 });
    const onceClient = new BandClient({
      apiKey: API_KEY,
      baseUrl: a.origin,
      maxRetries: 0,
      fetch: redirectErrorFetch(a),
    });
    const adapter = new FernRestAdapter(legacyClient, { onceClientFactory: () => onceClient, logger: new NoopLogger() });
    const message = { content: `a ${status} redirect`, mentions: [{ id: USER_ID }] };

    // The once port: the redirect lands as an error this caller classifies, never as a second POST.
    await expect(adapter.createChatMessageOnce(ROOM, message)).rejects.toBeTruthy();
    expect(a.posts).toBe(1);
    expect(b.posts).toBe(0);

    // The legacy port's Fetch follows the redirect: the same post stands at both origins.
    await adapter
      .createChatMessage(ROOM, { content: message.content, mentions: message.mentions })
      .then(() => undefined)
      .catch(() => undefined);
    expect(a.posts).toBe(2);
    expect(b.posts).toBe(1);

    await a.close();
    await b.close();
  });

  it("stands the redirected once post unknown in the journal, and a same-id retry reposts nothing", async () => {
    const { a, b } = await fixture(status);
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    // The legacy client stands for the port whose policy follows redirects; the
    // once port runs through the SDK-controlled client, whose Fetch refuses them.
    const legacyClient = new BandClient({ apiKey: API_KEY, baseUrl: a.origin, maxRetries: 0 });
    const onceClient = new BandClient({
      apiKey: API_KEY,
      baseUrl: a.origin,
      maxRetries: 0,
      fetch: redirectErrorFetch(a),
    });
    const adapter = new FernRestAdapter(legacyClient, { onceClientFactory: () => onceClient, logger: new NoopLogger() });
    const engine = new PublicationEngine({ roomId: ROOM,
      generation,
      logger: new NoopLogger(),
    });
    const message = { content: `a ${status} redirect`, mentions: [{ id: USER_ID }] };
    const run = () =>
      engine.publishOperation({
        operationId: OP_ID,
        kind: "send",
        content: message.content,
        mentions: [USER_ID],
        messageId: "msg-1",
        prepare: async () => ({
          recipients: [USER_ID],
          post: async () => adapter.createChatMessageOnce(ROOM, message),
        }),
      });

    // The first call's post redirects out of its origin: the attempt fails raw, the operation stands unknown.
    await expect(run()).rejects.toBeInstanceOf(DeliveryUnknownError);
    expect(a.posts).toBe(1);
    expect(b.posts).toBe(0);
    const room = await openRoom(generation, ROOM);
    expect(room.operation(OP_ID)?.outcome).toBe("unknown");

    // The retry joins the stored unknown: zero new posts to either origin.
    await expect(run()).rejects.toBeInstanceOf(DeliveryUnknownError);
    expect(a.posts).toBe(1);
    expect(b.posts).toBe(0);

    await generation.close();
    await a.close();
    await b.close();
  });
});

/**
 * The production wiring: `BandLink`'s default REST adapter installs the SDK's
 * once client (same endpoint and auth as the legacy client, no retries, a Fetch
 * that refuses redirects) behind `createChatMessageOnce`, and the operation
 * engine stands a keyed send on that port. The SDK declares a minimum of
 * Node 22.12: the once port's Fetch is the platform's global `fetch` with
 * `redirect: "error"`, and the journal's ownership lock stands on
 * `node:sqlite` — the minimum's consumer proof runs this suite's operation
 * suites on a Node 22.12 runtime.
 */
describe("the production BandLink's once port, through the operation engine", () => {
  for (const status of [307, 308] as const) {
    it(`a ${status} redirect from the post's origin stands unknown: one initial POST, no redirected POST, and a same-id retry adds zero POSTs`, async () => {
      const { a, b } = await fixture(status);
      const { generation } = await generationIn(tmpRoot());
      const link = new BandLink({ agentId: "agent-1", apiKey: API_KEY, restUrl: a.origin, logger: new NoopLogger() });
      expect(link.rest.hasOnceCapability?.() ?? link.rest.createChatMessageOnce !== undefined, "the production link advertises the once port").toBe(true);
      const engine = new PublicationEngine({ roomId: ROOM, generation, logger: new NoopLogger() });
      const roster = new ParticipantRoster();
      roster.add({ id: USER_ID, handle: USER_ID });
      const tools = new AgentTools({ roomId: ROOM, rest: link.rest, roster, publication: engine, inboundMessageId: () => "inbound-1" });
      const run = () => tools.sendMessage(`a ${status} redirect`, [USER_ID], { operationId: OP_ID });
      // The first call's post reaches origin A exactly once; the redirect out
      // of its origin lands as the attempt's error, never as a second POST,
      // and the operation stands unknown in the journal.
      await expect(run()).rejects.toBeInstanceOf(DeliveryUnknownError);
      expect(a.posts).toBe(1);
      expect(b.posts).toBe(0);
      expect((await openRoom(generation, ROOM)).operation(OP_ID)?.outcome).toBe("unknown");
      // A same-id retry through the engine joins the stored unknown: it is
      // announced with its id and reposts nothing — zero new POSTs to either
      // origin. The SDK never issues a second attempt for a keyed send.
      await expect(run()).rejects.toBeInstanceOf(DeliveryUnknownError);
      expect(a.posts).toBe(1);
      expect(b.posts).toBe(0);
      await generation.close();
      await a.close();
      await b.close();
    }, 60000);
  }

  it("refuses a keyed post before any request when an injected client stands without the once port", async () => {
    const { a, b } = await fixture(307);
    // A generated client stands in with no controlled once capability: the
    // port is not advertised, and the refusal stands before any request.
    const injected = new FernRestAdapter(
      new BandClient({ apiKey: API_KEY, baseUrl: a.origin, maxRetries: 0 }),
      { logger: new NoopLogger() },
    );
    const link = new BandLink({ agentId: "agent-1", apiKey: API_KEY, restUrl: a.origin, restApi: injected, logger: new NoopLogger() });
    await expect(
      link.rest.createChatMessageOnce?.(ROOM, { content: "no once port", mentions: [{ id: USER_ID }] }),
    ).rejects.toBeTruthy();
    expect(a.posts).toBe(0);
    expect(b.posts).toBe(0);
    await a.close();
    await b.close();
  });
});