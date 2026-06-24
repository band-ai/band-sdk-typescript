/**
 * Unit tests for the Band channel plugin assembly (createChatChannelPlugin).
 *
 * Covers the factory contract + the Step-5 split condition: the outbound
 * adapter maps our { messageId } onto an OutboundDeliveryResult (with the
 * channel field added) at the adapter boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
});
