import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import {
  parsePrivilegedCommand,
  PrivilegedCommandAuthorizer,
  type CommandAuthorizationHost,
} from "../src/commandAuthorization";
import { PluginStateStore, humanScope } from "../src/state";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000010";
const PARTICIPANT_ID = "00000000-0000-4000-8000-000000000020";
const roots: string[] = [];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const request = {
  senderId: PARTICIPANT_ID,
  senderName: "Remote Peer",
  command: "/deploy",
  content: "@band-bot /DEPLOY staging",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

async function createHarness(
  response: ElicitResult = {
    action: "accept",
    content: { decision: "deny_once" },
  },
  now = 10_000,
  details: ElicitResult = { action: "accept", content: {} },
) {
  const root = await mkdtemp(path.join(tmpdir(), "band-command-auth-"));
  roots.push(root);
  const state = new PluginStateStore(root, () => now);
  const elicitInput = vi.fn().mockImplementation(async (params: ElicitRequestFormParams) =>
    "decision" in params.requestedSchema.properties ? response : details);
  const host: CommandAuthorizationHost = {
    supportsFormElicitation: () => true,
    elicitInput,
  };
  const authorizer = new PrivilegedCommandAuthorizer({
    ownerId: OWNER_ID,
    profile: {
      scope: humanScope("https://app.band.ai", "profile-1"),
      projectRoot: "/projects/one",
      agentId: AGENT_ID,
    },
    state,
    host,
    logger,
    now: () => now,
  });
  return { state, host, elicitInput, authorizer };
}

describe("parsePrivilegedCommand", () => {
  it("recognizes a leading or mentioned slash command and canonicalizes its name", () => {
    expect(parsePrivilegedCommand("/Deploy staging")).toBe("/deploy");
    expect(parsePrivilegedCommand("@band-bot /plugin:Install foo")).toBe("/plugin:install");
  });

  it("does not classify URL slashes or ordinary prose as commands", () => {
    expect(parsePrivilegedCommand("see https://band.ai/path")).toBeNull();
    expect(parsePrivilegedCommand("please review this change")).toBeNull();
  });
});

describe("PrivilegedCommandAuthorizer", () => {
  it("always authorizes the owner without opening a prompt", async () => {
    const { state, elicitInput, authorizer } = await createHarness();

    await expect(authorizer.authorize({ ...request, senderId: OWNER_ID })).resolves.toEqual({
      allowed: true,
      note: null,
      source: "owner",
    });
    expect(elicitInput).not.toHaveBeenCalled();
    state.close();
  });

  it("runs once without persisting and defaults the local dialog to denial", async () => {
    const { state, elicitInput, authorizer } = await createHarness({
      action: "accept",
      content: { decision: "run_once" },
    });

    await expect(authorizer.authorize(request)).resolves.toMatchObject({
      allowed: true,
      source: "run_once",
    });
    await authorizer.authorize(request);

    expect(elicitInput).toHaveBeenCalledTimes(2);
    expect(elicitInput.mock.calls[0]?.[0]).toMatchObject({
      mode: "form",
      requestedSchema: {
        properties: {
          decision: { default: "deny_once", enum: [
            "deny_once", "run_once", "allow_command", "allow_all", "deny_timed",
          ] },
        },
      },
    });
    expect(Object.keys(elicitInput.mock.calls[0]?.[0].requestedSchema.properties)).toEqual(["decision"]);
    state.close();
  });

  it("persists a participant-command allowance without widening other commands", async () => {
    const { state, elicitInput, authorizer } = await createHarness({
      action: "accept",
      content: { decision: "allow_command" },
    });

    await authorizer.authorize(request);
    await expect(authorizer.authorize(request)).resolves.toMatchObject({
      allowed: true,
      source: "allow_command",
    });
    await authorizer.authorize({ ...request, command: "/review", content: "/review" });

    expect(elicitInput).toHaveBeenCalledTimes(2);
    state.close();
  });

  it("persists a participant-wide allowance for every slash command", async () => {
    const { state, elicitInput, authorizer } = await createHarness({
      action: "accept",
      content: { decision: "allow_all" },
    });

    await authorizer.authorize(request);
    await expect(
      authorizer.authorize({ ...request, command: "/review", content: "/review" }),
    ).resolves.toMatchObject({ allowed: true, source: "allow_all" });

    expect(elicitInput).toHaveBeenCalledTimes(1);
    state.close();
  });

  it("persists a timed denial and reuses its optional note", async () => {
    const { state, elicitInput, authorizer } = await createHarness({
      action: "accept",
      content: { decision: "deny_timed" },
    }, 10_000, {
      action: "accept",
      content: { deny_minutes: 30, note: "Deployment is frozen." },
    });

    await expect(authorizer.authorize(request)).resolves.toEqual({
      allowed: false,
      note: "Deployment is frozen.",
      source: "deny_timed",
    });
    await expect(authorizer.authorize(request)).resolves.toEqual({
      allowed: false,
      note: "Deployment is frozen.",
      source: "deny_timed",
    });
    expect(elicitInput).toHaveBeenCalledTimes(2);
    expect(elicitInput.mock.calls[1]?.[0].requestedSchema.properties).toHaveProperty("deny_minutes");
    state.close();
  });

  it("requests a denial note only after choosing deny once", async () => {
    const { state, elicitInput, authorizer } = await createHarness({
      action: "accept",
      content: { decision: "deny_once" },
    }, 10_000, { action: "accept", content: { note: "Not today." } });

    await expect(authorizer.authorize(request)).resolves.toEqual({
      allowed: false,
      note: "Not today.",
      source: "deny_once",
    });
    expect(Object.keys(elicitInput.mock.calls[1]?.[0].requestedSchema.properties)).toEqual(["note"]);
    state.close();
  });

  it("does not persist a timed policy when its details are cancelled", async () => {
    const { state, elicitInput, authorizer } = await createHarness({
      action: "accept",
      content: { decision: "deny_timed" },
    }, 10_000, { action: "decline" });

    await expect(authorizer.authorize(request)).resolves.toMatchObject({
      allowed: false,
      source: "deny_once",
    });
    await authorizer.authorize(request);
    expect(elicitInput).toHaveBeenCalledTimes(4);
    state.close();
  });

  it("denies without prompting for details when the policy form is declined", async () => {
    const { state, elicitInput, authorizer } = await createHarness({ action: "decline" });

    await expect(authorizer.authorize(request)).resolves.toEqual({
      allowed: false,
      note: null,
      source: "deny_once",
    });
    expect(elicitInput).toHaveBeenCalledTimes(1);
    state.close();
  });

  it("fails closed when the Claude client cannot show a local prompt", async () => {
    const { state, host, elicitInput, authorizer } = await createHarness();
    host.supportsFormElicitation = () => false;

    await expect(authorizer.authorize(request)).resolves.toEqual({
      allowed: false,
      note: null,
      source: "unavailable",
    });
    expect(elicitInput).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot prompt locally"),
      expect.objectContaining({ sender_id: PARTICIPANT_ID }),
    );
    state.close();
  });
});
