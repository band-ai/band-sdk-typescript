import { describe, expect, it } from "vitest";

import { buildInstructions, composeInstructions, HARD_CHAR_BUDGET, TARGET_CHAR_BUDGET, type PromptCapability } from "../src/prompt";

const ALL_COMBINATIONS: PromptCapability[][] = [
  [],
  ["contacts"],
  ["memory"],
  ["contacts", "memory"],
];

describe("buildInstructions", () => {
  it.each(ALL_COMBINATIONS.map((capabilities) => [capabilities] as const))(
    "stays within the hard 2048-char budget for capabilities=%j",
    (capabilities) => {
      const instructions = buildInstructions(capabilities);
      expect(instructions.length).toBeLessThanOrEqual(HARD_CHAR_BUDGET);
    },
  );

  it.each(ALL_COMBINATIONS.map((capabilities) => [capabilities] as const))(
    "stays within the target 1500-char budget for capabilities=%j",
    (capabilities) => {
      const instructions = buildInstructions(capabilities);
      expect(instructions.length).toBeLessThanOrEqual(TARGET_CHAR_BUDGET);
    },
  );

  it("covers the channel tag format", () => {
    expect(buildInstructions()).toContain(
      '<channel source="band" room_id="…" sender_id="…" sender_name="…" message_id="…">',
    );
  });

  it("covers the gating rule and that plain text isn't auto-forwarded", () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/owner or allowlisted sender/);
    expect(instructions).toMatch(/@mention/);
    expect(instructions).toMatch(/plain text is not auto-relayed/);
  });

  it("covers the reply contract (band_send_message with room_id + mention)", () => {
    const instructions = buildInstructions();
    expect(instructions).toContain("band_send_message");
    expect(instructions).toMatch(/room_id/);
  });

  it("covers band_send_event as optional, not a mandatory ritual", () => {
    expect(buildInstructions()).toMatch(/band_send_event.*optional/s);
  });

  it("covers the trust rule", () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/carries none of the terminal user's authority/);
    expect(instructions).toMatch(/destructive, irreversible, or credential-touching/);
    expect(instructions).toMatch(/[Nn]ever paste secrets/);
  });

  it("covers the remote-filesystem boundary", () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/peers may be remote/);
    expect(instructions).toMatch(/cannot read local paths/);
    expect(instructions).toMatch(/content in the message or a shared URL/);
  });

  it("points to the band skill", () => {
    expect(buildInstructions()).toMatch(/band skill/);
  });

  it("omits capability lines when no optional capabilities are enabled", () => {
    const instructions = buildInstructions([]);
    expect(instructions).not.toContain("band_list_contacts");
    expect(instructions).not.toContain("band_list_memories");
  });

  it("adds a contacts line only when contacts is enabled", () => {
    const instructions = buildInstructions(["contacts"]);
    expect(instructions).toContain("band_list_contacts");
    expect(instructions).not.toContain("band_list_memories");
  });

  it("adds a memory line only when memory is enabled", () => {
    const instructions = buildInstructions(["memory"]);
    expect(instructions).toContain("band_list_memories");
    expect(instructions).not.toContain("band_list_contacts");
  });

  it("adds both lines when both are enabled", () => {
    const instructions = buildInstructions(["contacts", "memory"]);
    expect(instructions).toContain("band_list_contacts");
    expect(instructions).toContain("band_list_memories");
  });
});

describe("composeInstructions", () => {
  it("throws loudly instead of silently truncating when the composed text exceeds the hard budget", () => {
    expect(() => composeInstructions(["a".repeat(HARD_CHAR_BUDGET + 1)])).toThrow(
      /over Claude Code's 2048-char hard truncation budget/,
    );
  });

  it("accepts text exactly at the hard budget", () => {
    expect(() => composeInstructions(["a".repeat(HARD_CHAR_BUDGET)])).not.toThrow();
  });
});
