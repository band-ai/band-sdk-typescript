import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, onTestFinished } from "vitest";

import { withTimeout } from "../../../src/adapters/shared/withTimeout";
import { redactDiagnostics } from "../../support/redactDiagnostics";

const CAPTURE_TIMEOUT_MS = 3_000;

/** Register after acquiring resources so timeout capture precedes their reverse-order release hooks. */
export function failureEvidence(collect: () => Promise<unknown>, secrets: readonly string[] = []) {
  const testName = expect.getState().currentTestName ?? "scenario";
  const directory = process.env.BAND_E2E_DIAGNOSTICS_DIR
    ?? join(dirname(process.env.BAND_E2E_SCORECARD_JSON ?? "scorecard/scorecard.json"), "diagnostics");
  const path = join(directory, `${testName.replace(/[^a-zA-Z0-9.-]+/g, "-").slice(0, 160)}-${randomUUID()}.json`);
  let saved: Promise<void> | undefined;
  const flush = (failure: unknown): Promise<void> => saved ??= (async () => {
    let evidence: unknown;
    try {
      evidence = await withTimeout(collect(), CAPTURE_TIMEOUT_MS, "diagnostic collection timed out");
    } catch (error) {
      evidence = { captureError: redactDiagnostics(error, secrets) };
    }
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify(redactDiagnostics({ testName, failure, evidence }, secrets), null, 2));
  })();
  onTestFinished(async ({ task }) => {
    if (task.result?.state === "fail") await flush(task.result.errors);
  });
  return {
    path,
    async run<T>(body: () => Promise<T>): Promise<T> {
      try {
        return await body();
      } catch (error) {
        await flush(error).catch((captureError: unknown) => console.warn("baseline diagnostic capture failed:", redactDiagnostics(captureError, secrets)));
        throw error;
      }
    },
  };
}
