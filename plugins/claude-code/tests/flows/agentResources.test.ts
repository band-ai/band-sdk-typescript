import { PassThrough } from "node:stream";
import { NoopLogger } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import { AgentSession } from "../../src/agentSession";
import { RecordLog } from "../../../../packages/sdk/tests/testUtils";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";
import { describe, expect, it } from "vitest";
import { AgentResources, agentResourceUri } from "../../src/agentResources";
import { BOARD_TOOL } from "../../src/board";
import { WS_URL_ENV } from "../../src/config";
import { SESSION_TEXT } from "../../src/sessions";
import { CONNECT_TOOL, connectTool, TOOL } from "../../src/tools";
import { AGENT_ID, AGENT_HANDLE, BandPlatform, type PlatformParticipant } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { ChannelClient, callTool, pick } from "../support/channelClient";
import { AGENT_NAME, ClaudeCodeSession, linkTo, SAVED_AGENT } from "./support/claudeCode";

const QA: PlatformParticipant = { id: "qa", type: "Agent", handle: "owner/qa", name: "Quality", description: "Checks changes" };
const DOCS: PlatformParticipant = { id: "docs", type: "Agent", handle: "owner/docs", name: "Docs", description: null };
const FIND = TOOL.findAgents;

async function listed(session: ClaudeCodeSession) {
  return (await session.client.listResources()).resources;
}
async function metadata(session: ClaudeCodeSession, handle: string) {
  const { contents } = await session.client.readResource({ uri: agentResourceUri(handle) });
  return JSON.parse((contents[0] as { text: string }).text);
}
async function ready(session: ClaudeCodeSession, handle = QA.handle!) {
  await session.resourcesWhen((rows) => rows.some((row) => row.uri === agentResourceUri(handle)));
}

describe("reachable agents through the real MCP protocol", () => {
  it.each([false, true])("lists handled agents and reads canonical metadata with board enabled=%s", async (board) => {
    const escaped = { ...DOCS, handle: "Owner/docs %?#", description: "   " };
    const platform = BandPlatform.host([QA, escaped,
      { ...QA, id: AGENT_ID, handle: AGENT_HANDLE },
      { ...QA, id: "user", type: "User" },
      { ...QA, id: "blank", handle: " @ " },
      { ...QA, id: "missing", handle: null }], { featureFlags: { ff_room_tasks: board } });
    await using session = await ClaudeCodeSession.connect(linkTo(platform));
    await ready(session);
    expect(await listed(session)).toEqual([
      { uri: "band://agent/owner/docs%20%25%3F%23", name: "@owner/docs %?#", description: "Docs", mimeType: "text/plain" },
      { uri: "band://agent/owner/qa", name: "@owner/qa", description: QA.description, mimeType: "text/plain" },
    ]);
    const { contents } = await session.client.readResource({ uri: "band://agent/owner/docs%20%25%3F%23" });
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual({ handle: "owner/docs %?#", name: "Docs", description: null });
    expect(await metadata(session, QA.handle!)).toEqual({ handle: QA.handle, name: QA.name, description: QA.description });
    expect((await session.client.listResourceTemplates()).resourceTemplates).toEqual([]);
    await expect(metadata(session, "owner/unknown")).rejects.toThrow("Unknown Band agent resource");
    expect((await session.toolNames()).sort()).toEqual([...Object.values(TOOL), ...(board ? Object.keys(BOARD_TOOL) : [])].sort());
  });

  it("refreshes the full directory before filtering, compares every metadata field, and ignores ordering", async () => {
    const peers = [QA];
    const platform = BandPlatform.host(peers);
    await using session = await ClaudeCodeSession.connect(linkTo(platform));
    await ready(session);
    peers.push(DOCS);
    const before = platform.rest.peerCalls.entries.length;
    expect((await session.callTool(FIND, { query: "quality" })).text).not.toContain("Docs");
    await ready(session, DOCS.handle!);
    expect(platform.rest.peerCalls.entries.slice(before)).toEqual([1, 2]);
    peers[0] = { ...QA, name: "Renamed", description: QA.description };
    let from = session.resourceRelists.entries.length;
    await session.callTool(FIND, {});
    await session.resourceRelists.next(() => true, from);
    expect(await metadata(session, QA.handle!)).toMatchObject({ name: "Renamed" });
    peers[0] = { ...peers[0], description: "New description" };
    from = session.resourceRelists.entries.length;
    await session.callTool(FIND, {});
    await session.resourceRelists.next((rows) => rows.some((row) => row.description === "New description"), from);
    // A notification from an equivalent ordering would precede this protocol barrier.
    from = session.resourceRelists.entries.length;
    peers.reverse();
    await session.callTool(FIND, {});
    await listed(session);
    expect(session.resourceRelists.entries).toHaveLength(from);
    peers.splice(peers.findIndex((peer) => peer.id === QA.id), 1);
    await session.callTool(FIND, {});
    await session.resourcesWhen((rows) => rows.length === 1);
    await expect(metadata(session, QA.handle!)).rejects.toThrow("Unknown Band agent resource");
    peers.push(QA);
    const failedRoom = await session.callTool(FIND, { room_id: "not-admitted" });
    expect(failedRoom.isError).toBe(true);
    await ready(session);
  });

  it("keeps tools usable after an initial failure, recovers, and retains the last snapshot after a failed refresh", async () => {
    const platform = BandPlatform.host([QA]);
    const failure = platform.rest.peerHolds.hold((page) => page === 1, { error: new Error("peer listing unavailable") });
    await using session = new ClaudeCodeSession(linkTo(platform), { agent: null });
    await session.connect();
    await session.question();
    session.answer(pick(AGENT_NAME));
    const connecting = session.callTool(CONNECT_TOOL, {});
    await failure.sending;
    failure.release();
    expect((await connecting).isError).toBe(false);
    expect(await listed(session)).toEqual([]);
    expect((await session.callTool(FIND, {})).isError).toBe(false);
    await ready(session);
    const snapshot = await listed(session);
    const refreshFailure = platform.rest.peerHolds.hold(() => true, { error: new Error("refresh unavailable") });
    const refreshing = session.callTool(FIND, {});
    await refreshFailure.sending;
    refreshFailure.release();
    expect(await refreshing).toEqual({ isError: true, text: "refresh unavailable" });
    expect(await listed(session)).toEqual(snapshot);
  });

  it("waits for the initial directory before reporting a live successful connection", async () => {
    const platform = BandPlatform.host([QA]);
    const initial = platform.rest.peerHolds.hold(() => true);
    const replies = new RecordLog<unknown>();
    await using session = new ClaudeCodeSession(linkTo(platform), { agent: null });
    await session.connect();
    await session.question();
    session.answer(pick(AGENT_NAME));
    const connecting = session.callTool(CONNECT_TOOL, {}).then((reply) => { replies.record(reply); return reply; });
    await initial.sending;
    await session.client.ping();
    expect(replies.entries).toEqual([]);
    initial.release();
    expect((await connecting).isError).toBe(false);
    expect(await metadata(session, QA.handle!)).toMatchObject({ name: QA.name });
  });

  it("keeps connections, snapshots and tool results usable when resource notifications fail", async () => {
    class NotificationFailure extends BandMcpStdioServer {
      public override async resourcesChanged(): Promise<void> { throw new Error("notification unavailable"); }
    }
    using dirs = new ClaudeCodeDirs();
    dirs.save({ [AGENT_NAME]: SAVED_AGENT });
    const peers = [QA];
    const platform = BandPlatform.host(peers);
    const resources = new AgentResources();
    const input = new PassThrough();
    const output = new PassThrough();
    const connect = connectTool(() => session.ask());
    const server = new NotificationFailure({ stdin: input, stdout: output, resources, additionalTools: [connect] });
    const session = new AgentSession({ server, resources, connectTool: connect, env: dirs.env("session"), link: linkTo(platform), logger: new NoopLogger(), push: async () => undefined });
    try {
      await server.start();
      const channel = new ChannelClient(output, input, server.stopped, "test");
      await channel.connect();
      expect(await session.connectAs(AGENT_NAME)).toBe(SESSION_TEXT.connected(`${AGENT_NAME} (@${AGENT_HANDLE})`));
      expect((await channel.client.listResources()).resources.map((row) => row.name)).toEqual(["@owner/qa"]);
      peers.push(DOCS);
      expect((await callTool(channel.client, FIND, {})).isError).toBe(false);
      expect((await channel.client.listResources()).resources.map((row) => row.name)).toEqual(["@owner/docs", "@owner/qa"]);
      await session.close();
      expect((await channel.client.listResources()).resources).toEqual([]);
    } finally {
      await session.close();
      await server.stop();
    }
  });

  it("does not publish an older initial result after a newer refresh", async () => {
    const peers = [QA];
    const platform = BandPlatform.host(peers);
    const initial = platform.rest.peerHolds.hold(() => true);
    await using session = new ClaudeCodeSession(linkTo(platform), { agent: null });
    await session.connect();
    await session.question();
    session.answer(pick(AGENT_NAME));
    const connecting = session.callTool(CONNECT_TOOL, {});
    await initial.sending;
    peers.splice(0, peers.length, DOCS);
    await session.callTool(FIND, { query: "docs" });
    initial.release();
    await connecting;
    expect((await listed(session)).map((row) => row.name)).toEqual(["@owner/docs"]);
    await expect(metadata(session, QA.handle!)).rejects.toThrow("Unknown Band agent resource");
  });

  it("keeps the newer fetch current when an older refresh finishes first", async () => {
    const peers = [QA];
    const platform = BandPlatform.host(peers);
    await using session = await ClaudeCodeSession.connect(linkTo(platform));
    await ready(session);
    peers.splice(0, peers.length, DOCS);
    const older = platform.rest.peerHolds.hold(() => true);
    const first = session.callTool(FIND, {});
    await older.sending;
    peers.splice(0, peers.length, { ...QA, name: "Latest" });
    const newer = platform.rest.peerHolds.hold(() => true);
    const second = session.callTool(FIND, {});
    await newer.sending;
    older.release();
    await first;
    expect(await metadata(session, QA.handle!)).toMatchObject({ name: QA.name });
    newer.release();
    await second;
    expect(await metadata(session, QA.handle!)).toMatchObject({ name: "Latest" });
  });

  it.each([false, true])("ignores older overlapping refreshes after newer success/failure (failure=%s)", async (fail) => {
    const peers = [QA];
    const platform = BandPlatform.host(peers);
    await using session = await ClaudeCodeSession.connect(linkTo(platform));
    await ready(session);
    peers.splice(0, peers.length, DOCS);
    const older = platform.rest.peerHolds.hold(() => true);
    const first = session.callTool(FIND, {});
    await older.sending;
    peers.splice(0, peers.length, { ...QA, name: "Latest" });
    const newer = fail ? platform.rest.peerHolds.hold(() => true, { error: new Error("newer failed") }) : undefined;
    const second = session.callTool(FIND, {});
    if (newer) { await newer.sending; newer.release(); }
    expect((await second).isError).toBe(fail);
    older.release();
    await first;
    expect(await metadata(session, QA.handle!)).toMatchObject({ name: fail ? QA.name : "Latest" });
    await expect(metadata(session, DOCS.handle!)).rejects.toThrow("Unknown Band agent resource");
  });

  it("reconnects as another identity with only its directory and board capability", async () => {
    await using peer = await FakePhoenixPeer.start();
    const first = BandPlatform.host([QA], { featureFlags: { ff_room_tasks: true } });
    const otherId = "another-agent";
    const second = BandPlatform.host([DOCS, { id: otherId, name: "Other", type: "Agent", handle: "owner/other" }], { id: otherId });
    using dirs = new ClaudeCodeDirs();
    dirs.save({ [AGENT_NAME]: SAVED_AGENT, other: { agentId: otherId, apiKey: "other-key", handle: "owner/other" } });
    await using session = await ClaudeCodeSession.connect(({ agentId }) => ({ restApi: agentId === AGENT_ID ? first.rest : second.rest }), { dirs, env: { [WS_URL_ENV]: peer.url } });
    await ready(session);
    expect((await session.toolNames()).sort()).toEqual([...Object.values(TOOL), ...Object.keys(BOARD_TOOL)].sort());
    await peer.endConnections(AGENT_ID, "agent.revoked", "Pick another agent");
    await session.toolNamesWhen((names) => names.includes(CONNECT_TOOL));
    expect(await listed(session)).toEqual([]);
    session.answer(pick("other"));
    expect((await session.callTool(CONNECT_TOOL, {})).isError).toBe(false);
    expect((await listed(session)).map((row) => row.name)).toEqual(["@owner/docs"]);
    expect((await session.toolNames()).sort()).toEqual(Object.values(TOOL).sort());
    await expect(metadata(session, QA.handle!)).rejects.toThrow("Unknown Band agent resource");
  });

  it("releases a connect gate before its held initial response and rejects cross-connection publication", async () => {
    await using peer = await FakePhoenixPeer.start();
    const peers = [QA];
    const featureFlags = { ff_room_tasks: true };
    const platform = BandPlatform.host(peers, { featureFlags });
    const initial = platform.rest.peerHolds.hold(() => true);
    await using session = new ClaudeCodeSession(() => ({ restApi: platform.rest }), { agent: null, env: { [WS_URL_ENV]: peer.url } });
    await session.connect();
    await session.question();
    expect(await listed(session)).toEqual([]);
    session.answer(pick(AGENT_NAME));
    const connecting = session.callTool(CONNECT_TOOL, {});
    await initial.sending;
    try {
      await peer.endConnections(AGENT_ID, "agent.revoked", "Reconnect");
      expect((await connecting).text).toContain("Reconnect");
      expect(await session.toolNamesWhen((names) => names.includes(CONNECT_TOOL))).toEqual([CONNECT_TOOL]);
      expect(await listed(session)).toEqual([]);
      expect((await session.client.listResourceTemplates()).resourceTemplates).toEqual([]);
      peers.splice(0, peers.length, DOCS);
      featureFlags.ff_room_tasks = false;
      session.answer(pick(AGENT_NAME));
      expect((await session.callTool(CONNECT_TOOL, {})).isError).toBe(false);
      expect((await session.toolNames()).sort()).toEqual(Object.values(TOOL).sort());
      expect((await listed(session)).map((row) => row.name)).toEqual(["@owner/docs"]);
    } finally { initial.release(); }
    // A protocol barrier gives the released response its turn without refreshing the directory.
    await session.client.ping();
    expect((await listed(session)).map((row) => row.name)).toEqual(["@owner/docs"]);
    await expect(metadata(session, QA.handle!)).rejects.toThrow("Unknown Band agent resource");
  });
});
