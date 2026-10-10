import { AgentResources } from "../../src/agentResources";
/** A real channel write can outlive the connection displaced while stdout is backpressured. */
import { PassThrough } from "node:stream";

import { NoopLogger } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import { expect, it } from "vitest";

import { AgentSession } from "../../src/agentSession";
import { CHANNEL_METHOD } from "../../src/channel";
import { WS_URL_ENV } from "../../src/config";
import { SESSION_TEXT } from "../../src/sessions";
import { CONNECT_TOOL, connectTool, TOOL } from "../../src/tools";
import { AGENT_HANDLE, AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { CallHolds, RecordLog } from "../../../../packages/sdk/tests/testUtils";
import { ChannelClient } from "../support/channelClient";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";
import { AGENT_NAME, SAVED_AGENT } from "./support/claudeCode";

class ObservedServer extends BandMcpStdioServer {
  public readonly removals = new RecordLog<readonly string[]>();

  public override removeTools(names: string[]): void {
    super.removeTools(names);
    this.removals.record(names);
  }
}

it("does not restart activity when a backpressured channel push finishes after takeover", async () => {
  using dirs = new ClaudeCodeDirs();
  dirs.save({ [AGENT_NAME]: SAVED_AGENT });
  await using peer = await FakePhoenixPeer.start();
  const platform = BandPlatform.host([person("user")]);
  const room = await platform.room("room");
  const waiting = room.postBeforeConnect("user", `@[[${AGENT_ID}]] hello`);
  const writes = new CallHolds<[string]>();
  const held = writes.hold((text) => text.includes(CHANNEL_METHOD));
  const output = new PassThrough({
    highWaterMark: 1,
    transform(chunk: Buffer, _encoding, callback) {
      this.push(chunk);
      void writes.pass(chunk.toString()).then(() => callback());
    },
  });
  const input = new PassThrough();
  const connect = connectTool(() => session.ask());
  const server = new ObservedServer({ stdin: input, stdout: output, additionalTools: [connect] });
  const status = dirs.openStatus("session");
  const session = new AgentSession({
    server,
    resources: new AgentResources(),
    connectTool: connect,
    env: { ...dirs.env("session"), [WS_URL_ENV]: peer.url },
    status,
    link: () => ({ restApi: platform.rest }),
    logger: new NoopLogger(),
    push: async (push) => server.notify(CHANNEL_METHOD, push),
  });
  try {
    await server.start();
    const client = new ChannelClient(output, input, server.stopped, "test");
    await client.connect();
    const starting = session.connectAs(AGENT_NAME);
    await held.sending;

    await peer.endConnections(AGENT_ID, "session.already_connected", "another session took over");
    await server.removals.next((names) => names.includes(TOOL.reply));
    expect(dirs.session("session")?.sentence).toBe(SESSION_TEXT.takenOver(`@${AGENT_HANDLE}`));
    held.release();
    await starting;
    expect(await client.toolNamesWhen((names) => names.includes(CONNECT_TOOL))).toEqual([CONNECT_TOOL]);
    await room.outcome(waiting);

    expect(platform.rest.workingReports.entries).toEqual([]);
  } finally {
    held.release();
    await session.close();
    await server.stop();
    status.remove();
  }
});
