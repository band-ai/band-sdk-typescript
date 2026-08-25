/**
 * Unit tests for the Band channel plugin assembly (createChatChannelPlugin).
 *
 * Covers the factory contract + the Step-5 split condition: the outbound
 * adapter maps our { messageId } onto an OutboundDeliveryResult (with the
 * channel field added) at the adapter boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import { createBandChannelPlugin, BAND_CHANNEL_ID } from "../../src/channel.js";
import { setAccount, resetAccounts, trackLastSender } from "../../src/state.js";

// Minimal stub gateway (the real lifecycle is transport.ts / a later step).
const stubGateway = {
  startAccount: vi.fn(),
  stopAccount: vi.fn(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin = createBandChannelPlugin(stubGateway as any);

beforeEach(() => resetAccounts());

function connectAccount(createChatMessage = vi.fn().mockResolvedValue({ id: "msg-7" })) {
  const rest = {
    listChatParticipants: vi.fn().mockResolvedValue([
      { id: "agent-self", name: "AgentBot", type: "agent" },
      { id: "u-bob", name: "Bob", type: "user" },
    ]),
    createChatMessage,
  };
  setAccount("default", {
    link: { rest } as unknown as Parameters<typeof setAccount>[1]["link"],
    selfAgentId: "agent-self",
  });
  return { rest, createChatMessage };
}

describe("channel factory contract", () => {
  it("has the band id, meta, and chat-type capabilities", () => {
    expect(plugin.id).toBe(BAND_CHANNEL_ID);
    expect(plugin.meta?.label).toBe("Band");
    expect(plugin.capabilities?.chatTypes).toEqual(["direct", "group"]);
  });

  it("attaches the injected gateway and a mention adapter (F1/F3)", () => {
    expect(plugin.gateway).toBe(stubGateway);
    expect(typeof plugin.mentions?.stripMentions).toBe("function");
  });

  it("disables agent-side mention gating: groups.resolveRequireMention => false (L3)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requireMention = plugin.groups?.resolveRequireMention?.({} as any);
    expect(requireMention).toBe(false);
  });

  it("exposes config.resolveAccount and inspectAccount", () => {
    expect(typeof plugin.config?.resolveAccount).toBe("function");
    expect(typeof plugin.config?.inspectAccount).toBe("function");
  });

  it("wires security and outbound", () => {
    expect(plugin.security).toBeDefined();
    expect(typeof plugin.outbound?.sendText).toBe("function");
  });

  it("recognizes a Band room UUID as a direct send target (skips directory)", () => {
    const looksLikeId = plugin.messaging?.targetResolver?.looksLikeId;
    expect(typeof looksLikeId).toBe("function");
    // a real Band room id (UUID) is accepted, so the shared message tool routes
    // it straight to outbound.sendText instead of failing with "Unknown target"
    expect(looksLikeId!("2792f9d6-7ea1-4fcf-9150-32529e336ab6")).toBe(true);
    expect(looksLikeId!("  2792F9D6-7EA1-4FCF-9150-32529E336AB6  ")).toBe(true);
    // non-room-id values fall through to directory resolution
    expect(looksLikeId!("@amit.gazal")).toBe(false);
    expect(looksLikeId!("not-a-uuid")).toBe(false);
    expect(looksLikeId!("")).toBe(false);
  });
});

describe("outbound adapter mapping ({ messageId } -> OutboundDeliveryResult)", () => {
  it("maps the messageId and adds the channel field at the adapter boundary", async () => {
    const { createChatMessage } = connectAccount();
    trackLastSender("default", "room-1", { senderId: "u-bob", senderName: "Bob" });

    const result = await plugin.outbound!.sendText!({
      cfg: {} as never,
      to: "room-1",
      text: "hello",
      accountId: "default",
    });

    expect(result).toMatchObject({ channel: BAND_CHANNEL_ID, messageId: "msg-7" });
    expect(createChatMessage).toHaveBeenCalledWith("room-1", {
      content: "hello",
      mentions: [{ id: "u-bob", name: "Bob" }],
    });
  });

  it("throws when the account is not connected", async () => {
    await expect(
      plugin.outbound!.sendText!({ cfg: {} as never, to: "room-1", text: "hi", accountId: "ghost" }),
    ).rejects.toThrow(/not connected/i);
  });

  it("throws (does NOT misroute) for an explicit unknown accountId even if another account is connected", async () => {
    // Lock in the review fix: an explicit-but-unknown id must not silently fall
    // back to the sole connected account.
    connectAccount();
    await expect(
      plugin.outbound!.sendText!({ cfg: {} as never, to: "room-1", text: "hi @Bob", accountId: "ghost" }),
    ).rejects.toThrow(/not connected/i);
  });

  it("falls back to the sole connected account for cross-context sends (no accountId)", async () => {
    // Cross-context sends (e.g. from a Telegram session) carry no Band accountId;
    // the account is keyed by its configured id, not "default" — resolve the
    // single connected account instead of failing with 'account "default" ...'.
    const rest = {
      listChatParticipants: vi.fn().mockResolvedValue([
        { id: "agent-self", name: "AgentBot", type: "agent" },
        { id: "u-bob", name: "Bob", type: "user" },
      ]),
      createChatMessage: vi.fn().mockResolvedValue({ id: "msg-9" }),
    };
    setAccount("band-openclaw-accounr-id", {
      link: { rest } as unknown as Parameters<typeof setAccount>[1]["link"],
      selfAgentId: "agent-self",
    });

    const result = await plugin.outbound!.sendText!({
      cfg: {} as never,
      to: "room-1",
      text: "hi @Bob",
      accountId: null,
    });

    expect(result).toMatchObject({ channel: BAND_CHANNEL_ID, messageId: "msg-9" });
    expect(rest.createChatMessage).toHaveBeenCalled();
  });

  it("appends the mediaUrl to the text and maps { messageId } like sendText (sendMedia)", async () => {
    const { createChatMessage } = connectAccount();
    trackLastSender("default", "room-1", { senderId: "u-bob", senderName: "Bob" });

    const result = await plugin.outbound!.sendMedia!({
      cfg: {} as never,
      to: "room-1",
      text: "look",
      mediaUrl: "https://example.com/img.png",
      accountId: "default",
    });

    expect(result).toMatchObject({ channel: BAND_CHANNEL_ID, messageId: "msg-7" });
    expect(createChatMessage).toHaveBeenCalledWith("room-1", {
      content: "look\n\nhttps://example.com/img.png",
      mentions: [{ id: "u-bob", name: "Bob" }],
    });
  });
});

describe("config adapter delegates to config.ts helpers (asPluginConfig boundary)", () => {
  const cfg = {
    channels: {
      [BAND_CHANNEL_ID]: {
        accounts: { default: { apiKey: "k", agentId: "a" }, second: {} },
      },
    },
  } as unknown as OpenClawConfig;

  it("listAccountIds returns every configured account id", () => {
    expect(plugin.config!.listAccountIds!(cfg)).toEqual(["default", "second"]);
  });

  it("resolveAccount defaults accountId to the default account", () => {
    expect(plugin.config!.resolveAccount!(cfg)).toMatchObject({ apiKey: "k", agentId: "a" });
    expect(plugin.config!.resolveAccount!(cfg, "second")).toMatchObject({});
  });

  it("inspectAccount reports configured only when apiKey + agentId are both present", () => {
    expect(plugin.config!.inspectAccount!(cfg, "default")).toMatchObject({ configured: true, agentId: "a" });
    expect(plugin.config!.inspectAccount!(cfg, "second")).toMatchObject({ configured: false });
  });
});

describe("mentions.stripMentions", () => {
  const cfgWithAgent = {
    agents: { list: [{ id: "agent1", identity: { name: "AgentBot" } }] },
  } as unknown as OpenClawConfig;

  it("strips the configured agent's name token and trims the remainder (F2)", () => {
    const out = plugin.mentions!.stripMentions!({
      text: "AgentBot   do the thing",
      cfg: cfgWithAgent,
      agentId: "agent1",
    });
    expect(out).toBe("do the thing");
  });

  it("leaves text untouched when the agent id has no configured identity", () => {
    const out = plugin.mentions!.stripMentions!({
      text: "just a message",
      cfg: cfgWithAgent,
      agentId: "unknown-agent",
    });
    expect(out).toBe("just a message");
  });
});

/** Structural view for reading the account this test writes via applyAccountConfig. */
type ConfigWithBandAccounts = {
  channels: Record<string, { accounts: Record<string, Record<string, unknown>> }>;
};

describe("setup.applyAccountConfig delegates non-interactive channels-add input", () => {
  it("maps token/userId/httpUrl into the account and enables the channel", () => {
    const cfg = {} as unknown as OpenClawConfig;
    const input: ChannelSetupInput = { token: "band_a_x", userId: "agent-1", httpUrl: "wss://custom/socket" };
    const next = plugin.setup!.applyAccountConfig!({ cfg, accountId: "default", input });
    const view = next as unknown as ConfigWithBandAccounts;
    const account = view.channels[BAND_CHANNEL_ID].accounts.default;
    expect(account).toMatchObject({ apiKey: "band_a_x", agentId: "agent-1", wsUrl: "wss://custom/socket" });
  });
});

describe("agentPrompt.messageToolHints", () => {
  it("returns the static Band instructions", () => {
    const hints = plugin.agentPrompt!.messageToolHints!();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("Band");
  });
});

describe("security.dm", () => {
  it("is always open — Band already gates delivery (L3)", async () => {
    // resolveDmPolicy is the public surface createChatChannelPlugin exposes;
    // it closes over our resolvePolicy/resolveAllowFrom callbacks internally.
    const resolveDmPolicy = plugin.security!.resolveDmPolicy!;
    const result = await resolveDmPolicy({
      cfg: {} as never,
      accountId: "default",
      account: { accountId: "default" } as never,
    });
    expect(result).toMatchObject({ policy: "open", allowFrom: [] });
  });
});
