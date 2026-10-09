import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_INSTRUCTIONS, CHANNEL_OFF_INSTRUCTIONS } from "../../src/prompt";

function promptInstructions(file: string): string {
  const prompt = readFileSync(file, "utf8");
  const block = /append_system_prompt: \|\n([\s\S]*?)\n---/.exec(prompt)?.[1];
  expect(block, file).toBeDefined();
  return block!.split("\n").map((line) => line.replace(/^  /, "")).join("\n");
}

for (const [state, instructions] of [["connected", CHANNEL_INSTRUCTIONS], ["off", CHANNEL_OFF_INSTRUCTIONS]] as const) {
  describe(`${state} eval instructions`, () => {
    const root = resolve("evals", state);
    const scenarios = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "mocks");
    it.each(scenarios.map((entry) => entry.name))("%s copies only its session state's rules", (name) => {
      // The off directory also covers an unpicked agent with its channel enabled.
      const expected = state === "off" && name !== "add-agent-without-channel" ? CHANNEL_INSTRUCTIONS : instructions;
      expect(promptInstructions(resolve(root, name, "prompt.md"))).toBe(expected);
    });
  });
}
