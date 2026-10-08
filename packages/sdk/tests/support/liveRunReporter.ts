import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Reporter, SerializedError, TestModule, TestRunEndReason, Vitest } from "vitest/node";

import { LIVE_REPORT_ENV, liveRunSchema, type LiveLane, type LiveRun } from "./liveRunReport";
import { redactDiagnosticText } from "./redactDiagnostics";

const errors = (items: ReadonlyArray<{ message: string; stack?: string }> | undefined) => (items ?? []).map((error) => ({
  message: redactDiagnosticText(error.message),
  ...(error.stack ? { stack: redactDiagnosticText(error.stack) } : {}),
}));

export default class LiveRunReporter implements Reporter {
  private namePattern: RegExp | undefined;
  public constructor(private readonly options: { lane: LiveLane }) {}

  public onInit(vitest: Vitest): void {
    this.namePattern = vitest.config.testNamePattern;
  }

  public onTestRunEnd(modules: ReadonlyArray<TestModule>, unhandled: ReadonlyArray<SerializedError>, reason: TestRunEndReason): void {
    const path = process.env[LIVE_REPORT_ENV];
    if (!path) return;
    const report: LiveRun = {
      version: 1,
      lane: this.options.lane,
      reason,
      modules: modules.map((module) => ({
        file: module.relativeModuleId,
        errors: errors(module.errors()),
        suites: [...module.children.allSuites()].map((suite) => ({ name: suite.name, fullName: suite.fullName, errors: errors(suite.errors()) })),
        tests: [...module.children.allTests()].map((test) => {
          const result = test.result();
          const diagnostic = test.diagnostic();
          return {
            id: test.id,
            name: test.name,
            fullName: test.fullName,
            parent: test.parent.type === "suite" ? { type: "suite" as const, name: test.parent.name } : { type: "module" as const },
            state: result.state,
            mode: test.options.mode,
            // Vitest replaces options.mode with skip for names outside -t.
            filtered: result.state === "skipped" && !result.note && Boolean(this.namePattern && !test.fullName.match(this.namePattern)),
            ...(result.state === "skipped" && result.note ? { note: redactDiagnosticText(result.note) } : {}),
            durationMs: diagnostic?.duration ?? 0,
            retryCount: diagnostic?.retryCount ?? 0,
            repeatCount: diagnostic?.repeatCount ?? 0,
            flaky: diagnostic?.flaky ?? false,
            errors: errors(result.errors),
          };
        }),
      })),
      unhandledErrors: errors(unhandled),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(liveRunSchema.parse(report), null, 2)}\n`);
  }
}
