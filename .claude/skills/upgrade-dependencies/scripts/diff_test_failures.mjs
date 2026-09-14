#!/usr/bin/env node
// Compares two vitest JSON reporter outputs and reports which failing tests
// in the candidate run are NEW relative to the baseline run — i.e. actually
// caused by whatever changed between the two runs, not pre-existing flakes.
//
// Usage: node diff_test_failures.mjs <baseline.json> <candidate.json>
// Produces both files with:
//   pnpm --filter <pkg> test -- --reporter=json --outputFile=<path>
// Exits 0 and prints "no new failures" if the candidate has no failures the
// baseline didn't already have. Exits 1 and lists the new failures otherwise.

import { readFileSync } from "node:fs";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error("usage: diff_test_failures.mjs <baseline.json> <candidate.json>");
  process.exit(2);
}

function failedTestIds(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const ids = new Set();
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      if (test.status === "failed") {
        ids.add(`${file.name}::${test.fullName ?? test.title}`);
      }
    }
  }
  return ids;
}

const baseline = failedTestIds(baselinePath);
const candidate = failedTestIds(candidatePath);

const newFailures = [...candidate].filter((id) => !baseline.has(id));
const fixedFailures = [...baseline].filter((id) => !candidate.has(id));

if (newFailures.length === 0) {
  console.log("No new failures vs. baseline.");
  if (fixedFailures.length > 0) {
    console.log(`(${fixedFailures.length} baseline failure(s) no longer failing — unrelated improvement or flake.)`);
  }
  if (baseline.size > 0) {
    console.log(`Note: ${baseline.size} pre-existing baseline failure(s) still present, unrelated to this change:`);
    for (const id of baseline) if (candidate.has(id)) console.log(`  - ${id}`);
  }
  process.exit(0);
}

console.log(`${newFailures.length} NEW failure(s) not present in baseline:`);
for (const id of newFailures) console.log(`  - ${id}`);
process.exit(1);
