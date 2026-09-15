import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";

const LOW_COVERAGE_PERCENT = 80;

function displayPath(path) {
  const marker = "/crates/";
  const index = path.indexOf(marker);
  return index >= 0 ? path.slice(index + 1) : basename(path);
}

export function parseLcov(text) {
  const records = [];
  let source;
  let found = 0;
  let hit = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) source = line.slice(3);
    else if (line.startsWith("LF:")) found = Number(line.slice(3));
    else if (line.startsWith("LH:")) hit = Number(line.slice(3));
    else if (line === "end_of_record" && source) {
      records.push({ path: displayPath(source), found, hit, missed: found - hit, percent: found ? (100 * hit) / found : 100 });
      source = undefined;
      found = 0;
      hit = 0;
    }
  }
  return records;
}

export function renderDigest({ lcov, label, recipients, runUrl, result }) {
  const header = `## Weekly Core coverage: ${result === "success" ? "PASS" : result.toUpperCase()}`;
  if (!lcov) return [header, recipients, "", "No LCOV report was produced. See the failed run for details.", "", `[Open run](${runUrl})`].join("\n");

  const records = parseLcov(lcov);
  const found = records.reduce((total, record) => total + record.found, 0);
  const hit = records.reduce((total, record) => total + record.hit, 0);
  const gaps = records
    .filter((record) => record.percent < LOW_COVERAGE_PERCENT)
    .sort((left, right) => left.percent - right.percent || right.found - left.found || left.path.localeCompare(right.path));
  const lines = [header, recipients, "", `**${label}: ${found ? ((100 * hit) / found).toFixed(2) : "0.00"}% lines** (${hit}/${found}). Low coverage is below ${LOW_COVERAGE_PERCENT}%.`, ""];
  if (gaps.length) {
    lines.push("### Low or uncovered files", "", "| File | Lines | Missed |", "| --- | ---: | ---: |");
    lines.push(...gaps.map((record) => `| \`${record.path}\` | ${record.percent.toFixed(2)}% | ${record.missed}/${record.found} |`));
  } else {
    lines.push("All measured files meet the coverage floor.");
  }
  lines.push("", `[Open run and coverage artifact](${runUrl}#artifacts)`);
  return lines.join("\n");
}

async function main() {
  let lcov;
  try {
    lcov = await readFile(process.env.LCOV_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const body = renderDigest({
    lcov,
    label: process.env.REPORT_LABEL,
    recipients: process.env.RECIPIENTS,
    runUrl: process.env.RUN_URL,
    result: process.env.WORKFLOW_RESULT,
  });
  const result = spawnSync("gh", ["api", `repos/${process.env.REPO}/commits/${process.env.SHA}/comments`, "--method", "POST", "-f", `body=${body}`], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
