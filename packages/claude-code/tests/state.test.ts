import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_LEASE_TTL_MS,
  PluginStateStore,
  humanScope,
  type ClaudeSessionContext,
} from "../src/state";

const AGENT_ID = "00000000-0000-4000-8000-000000000010";
const FIRST: ClaudeSessionContext = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  projectRoot: "/projects/one",
};
const SECOND: ClaudeSessionContext = {
  sessionId: "00000000-0000-4000-8000-000000000002",
  projectRoot: "/projects/one",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginStateStore", () => {
  it("restores an agent only for the exact account, project, and Claude transcript", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "band-claude-state-"));
    roots.push(root);
    const state = new PluginStateStore(root);
    const scope = humanScope("https://app.band.ai", "user-1");

    state.bind(scope, FIRST, AGENT_ID);

    expect(state.getBinding(scope, FIRST)).toBe(AGENT_ID);
    expect(state.getBinding(scope, SECOND)).toBeNull();
    expect(state.getBinding(scope, { ...FIRST, projectRoot: "/projects/two" })).toBeNull();
    expect(state.getBinding(humanScope("https://app.band.ai", "user-2"), FIRST)).toBeNull();
    state.close();
  });

  it("remembers deliveries per transcript across reopen, so a new transcript still receives the message", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "band-claude-delivery-"));
    roots.push(root);
    const scope = humanScope("https://app.band.ai", "user-1");
    const delivery = {
      scope,
      agentId: AGENT_ID,
      sessionId: FIRST.sessionId,
      messageId: "msg-1",
    };

    const first = new PluginStateStore(root);
    first.recordDelivered(delivery);
    first.close();

    const reopened = new PluginStateStore(root);
    expect(reopened.wasDelivered(delivery)).toBe(true);
    expect(reopened.wasDelivered({ ...delivery, sessionId: SECOND.sessionId })).toBe(false);
    expect(reopened.wasDelivered({ ...delivery, messageId: "msg-2" })).toBe(false);
    reopened.close();
  });

  it("excludes a live identity from another session and permits takeover after lease expiry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "band-claude-lease-"));
    roots.push(root);
    let now = 1_000;
    const first = new PluginStateStore(root, () => now);
    const second = new PluginStateStore(root, () => now);
    const scope = humanScope("https://app.band.ai", "user-1");

    expect(first.acquireLease(scope, FIRST, AGENT_ID)).toBe(true);
    expect(second.leasedByAnotherSession(scope, SECOND, AGENT_ID)).toBe(true);
    expect(second.acquireLease(scope, SECOND, AGENT_ID)).toBe(false);

    now += AGENT_LEASE_TTL_MS + 1;
    expect(second.acquireLease(scope, SECOND, AGENT_ID)).toBe(true);
    expect(first.heartbeatLease(scope, FIRST, AGENT_ID)).toBe(false);

    first.close();
    second.close();
  });

  it("scopes command allowances and timed denials to the Band profile, project, and agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "band-claude-command-policy-"));
    roots.push(root);
    let now = 10_000;
    const state = new PluginStateStore(root, () => now);
    const profile = {
      scope: humanScope("https://app.band.ai", "user-1"),
      projectRoot: FIRST.projectRoot,
      agentId: AGENT_ID,
    };

    state.allowCommand(profile, "participant-1", "/review");
    expect(state.getCommandAccess(profile, "participant-1", "/review")).toEqual({
      kind: "allow_command",
    });
    expect(state.getCommandAccess(profile, "participant-1", "/deploy")).toEqual({
      kind: "prompt",
    });
    expect(
      state.getCommandAccess(
        { ...profile, projectRoot: "/projects/two" },
        "participant-1",
        "/review",
      ),
    ).toEqual({ kind: "prompt" });

    state.allowAllCommands(profile, "participant-2");
    expect(state.getCommandAccess(profile, "participant-2", "/deploy")).toEqual({
      kind: "allow_all",
    });

    state.denyCommandsUntil(profile, "participant-1", now + 60_000, "Please wait for review.");
    expect(state.getCommandAccess(profile, "participant-1", "/review")).toEqual({
      kind: "denied",
      note: "Please wait for review.",
      expiresAtMs: 70_000,
    });

    now = 70_001;
    expect(state.getCommandAccess(profile, "participant-1", "/review")).toEqual({
      kind: "allow_command",
    });
    state.close();
  });
});
