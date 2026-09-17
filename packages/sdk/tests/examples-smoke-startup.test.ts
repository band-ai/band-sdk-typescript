import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(new URL("../scripts/examples-smoke-startup.mjs", import.meta.url));

describe("example startup smoke", () => {
  it("reports a child that exits during the readiness window", async () => {
    const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
    const probe = `
      import { spawn } from "node:child_process";
      import { waitForStartupReadiness } from ${JSON.stringify(moduleUrl)};

      const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(1), 10)"]);
      const result = await waitForStartupReadiness(child, 200);
      console.log(JSON.stringify(result));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe]);

    expect(JSON.parse(stdout)).toEqual({ kind: "exit", code: 1, signal: null });
  });
});
