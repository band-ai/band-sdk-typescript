/**
 * Unit tests for the Band prompts module.
 *
 * Contract (D5 / INT-836 C1):
 *  - BASE_INSTRUCTIONS is STATIC (no prompt-time room_id injection)
 *  - fully rebranded thenvoi -> band (no "thenvoi" / "Thenvoi" anywhere)
 *  - room_id is sourced from the `[Band Room: <uuid>]` marker, NOT "the To field"
 *  - the dropped `band_send_message` tool is NOT referenced; the prompt instead
 *    tells the agent to reply in plain text and @mention a name to address it
 */

import { describe, it, expect } from "vitest";
import { BASE_INSTRUCTIONS, buildSystemPrompt } from "../../src/prompts.js";

describe("BASE_INSTRUCTIONS", () => {
  it("contains the Band channel instructions section", () => {
    expect(BASE_INSTRUCTIONS).toContain("## Band Channel Instructions");
  });

  it("explains the two operating contexts", () => {
    expect(BASE_INSTRUCTIONS).toContain("Webchat/CLI context");
    expect(BASE_INSTRUCTIONS).toContain("Band room context");
  });

  it("is fully rebranded — no 'thenvoi' references remain", () => {
    expect(BASE_INSTRUCTIONS.toLowerCase()).not.toContain("thenvoi");
  });

  it("sources room_id from the [Band Room: <uuid>] marker, not 'the To field'", () => {
    expect(BASE_INSTRUCTIONS).toContain("[Band Room:");
    expect(BASE_INSTRUCTIONS).not.toContain("To field");
  });

  it("lists band_* tools that work without room_id", () => {
    expect(BASE_INSTRUCTIONS).toContain("band_lookup_peers");
    expect(BASE_INSTRUCTIONS).toContain("band_add_contact");
    expect(BASE_INSTRUCTIONS).toContain("band_create_chatroom");
  });

  it("lists band_* tools that require room_id", () => {
    expect(BASE_INSTRUCTIONS).toContain("band_send_event");
    expect(BASE_INSTRUCTIONS).toContain("band_add_participant");
    expect(BASE_INSTRUCTIONS).toContain("band_get_participants");
  });

  it("does NOT reference the dropped band_send_message tool", () => {
    expect(BASE_INSTRUCTIONS).not.toContain("band_send_message");
  });

  it("directs cross-context sends to the message tool, not band_send_event", () => {
    expect(BASE_INSTRUCTIONS).toContain("Sending a message to a Band room (cross-context)");
    expect(BASE_INSTRUCTIONS).toContain("`message`");
    // band_send_event is explicitly framed as NOT a chat-message sender
    expect(BASE_INSTRUCTIONS).toMatch(/NOT how you send a chat message|only emits structured activity/);
  });

  it("tells the agent to reply in plain text and @mention to address someone", () => {
    expect(BASE_INSTRUCTIONS).toContain("plain text");
    expect(BASE_INSTRUCTIONS).toContain("Addressing a specific participant");
    expect(BASE_INSTRUCTIONS).toContain("@TheirName");
  });

  it("warns that @Name only resolves for participants already in the room", () => {
    expect(BASE_INSTRUCTIONS).toContain("already in this room");
    expect(BASE_INSTRUCTIONS).toContain("band_add_participant");
  });

  it("contains delegation instructions and examples", () => {
    expect(BASE_INSTRUCTIONS).toContain("Delegating to Other Agents");
    expect(BASE_INSTRUCTIONS).toContain("band_lookup_peers");
    expect(BASE_INSTRUCTIONS).toContain("Example:");
  });
});

describe("buildSystemPrompt", () => {
  it("includes agent identity", () => {
    const prompt = buildSystemPrompt("Weather Agent", "a helpful weather assistant");
    expect(prompt).toContain("You are Weather Agent");
    expect(prompt).toContain("a helpful weather assistant");
  });

  it("includes the base instructions", () => {
    const prompt = buildSystemPrompt("Test Agent", "a test agent");
    expect(prompt).toContain("## Band Channel Instructions");
  });

  it("includes and orders custom instructions between identity and base", () => {
    const prompt = buildSystemPrompt("Test Agent", "a test agent", "CUSTOM_MARKER");
    const identityIndex = prompt.indexOf("You are Test Agent");
    const customIndex = prompt.indexOf("CUSTOM_MARKER");
    const baseIndex = prompt.indexOf("## Band Channel Instructions");
    expect(identityIndex).toBeLessThan(customIndex);
    expect(customIndex).toBeLessThan(baseIndex);
  });

  it("works without custom instructions and never emits 'undefined'", () => {
    const prompt = buildSystemPrompt("Test Agent", "a test agent");
    expect(prompt).toContain("You are Test Agent");
    expect(prompt).not.toContain("undefined");
  });
});
