import { describe, expect, it } from "vitest";

import {
  EXAMPLE_ENTRY_SCRIPTS,
  expectGuardedExampleEntry,
} from "./helpers/exampleEntryScripts";

describe("example entry scripts", () => {
  it.each(EXAMPLE_ENTRY_SCRIPTS)(
    "$file loads $configKey and only runs when executed directly",
    ({ file, configKey }) => {
      expectGuardedExampleEntry(file, configKey);
    },
  );

  it("imports numbered entry modules without starting agents", async () => {
    for (const { file } of EXAMPLE_ENTRY_SCRIPTS) {
      const modulePath = `../${file.replace(/\.ts$/, "")}`;
      await expect(import(modulePath), file).resolves.toBeDefined();
    }
  });
});
