import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { redactDiagnosticText } from "../../../../packages/sdk/tests/support/redactDiagnostics";

/** Keep child-process command arguments out of thrown diagnostics, including the add command's API key. */
export async function agentsCommandAt(cli: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], { env });
    return stdout;
  } catch (error) {
    const { code, stderr } = error as { code?: number | string; stderr?: string };
    const addIndex = args.indexOf("add");
    const secrets = addIndex >= 0 && args[addIndex + 2] ? [args[addIndex + 2]] : [];
    throw new Error(redactDiagnosticText(`Band agents command failed (${code ?? "unknown"}): ${stderr || "no stderr"}`, secrets));
  }
}
