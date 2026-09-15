import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";

const LOW_COVERAGE_PERCENT = 80;
const MAX_UNTESTED_APIS = 24;
const MAX_MISSED_LINE_RANGES = 8;

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
  let functionsFound = 0;
  let functionsHit = 0;
  let missedLines = [];
  let functions = [];
  let functionHits = new Map();
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) source = line.slice(3);
    else if (line.startsWith("LF:")) found = Number(line.slice(3));
    else if (line.startsWith("LH:")) hit = Number(line.slice(3));
    else if (line.startsWith("FNF:")) functionsFound = Number(line.slice(4));
    else if (line.startsWith("FNH:")) functionsHit = Number(line.slice(4));
    else if (line.startsWith("DA:")) {
      const [lineNumber, count] = line.slice(3).split(",", 2);
      if (count === "0") missedLines.push(Number(lineNumber));
    } else if (line.startsWith("FN:")) {
      const [lineNumber, name] = line.slice(3).split(",", 2);
      functions.push({ line: Number(lineNumber), name });
    } else if (line.startsWith("FNDA:")) {
      const [count, name] = line.slice(5).split(",", 2);
      functionHits.set(name, (functionHits.get(name) ?? 0) + Number(count));
    }
    else if (line === "end_of_record" && source) {
      records.push({
        path: displayPath(source),
        found,
        hit,
        missed: found - hit,
        percent: found ? (100 * hit) / found : 100,
        functionsFound,
        functionsHit,
        missedLines,
        functions: functions.map((fn) => ({ ...fn, hits: functionHits.get(fn.name) ?? 0 })),
      });
      source = undefined;
      found = 0;
      hit = 0;
      functionsFound = 0;
      functionsHit = 0;
      missedLines = [];
      functions = [];
      functionHits = new Map();
    }
  }
  return records;
}

function formatLineRanges(numbers) {
  const ranges = [];
  let start;
  let previous;
  for (const number of numbers) {
    if (start === undefined) [start, previous] = [number, number];
    else if (number === previous + 1) previous = number;
    else {
      ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
      [start, previous] = [number, number];
    }
  }
  if (start !== undefined) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  const shown = ranges.slice(0, MAX_MISSED_LINE_RANGES).join(", ");
  return ranges.length <= MAX_MISSED_LINE_RANGES ? shown : `${shown}, … (${numbers.length} missed)`;
}

function isCoreApi({ name }) {
  return !name.startsWith("_") && !["free", "default"].includes(name) && !name.startsWith("cached");
}

export function renderDigest({ lcov, label, recipients, runUrl, result }) {
  const header = "## Weekly Core coverage report";
  if (!lcov) return [header, recipients, "", `The coverage run ${result}. No LCOV report was produced; see the run for details.`, "", `[Open run](${runUrl})`].join("\n");

  const records = parseLcov(lcov);
  const found = records.reduce((total, record) => total + record.found, 0);
  const hit = records.reduce((total, record) => total + record.hit, 0);
  const functionsFound = records.reduce((total, record) => total + record.functionsFound, 0);
  const functionsHit = records.reduce((total, record) => total + record.functionsHit, 0);
  const gaps = records
    .filter((record) => record.percent < LOW_COVERAGE_PERCENT)
    .sort((left, right) => left.percent - right.percent || right.found - left.found || left.path.localeCompare(right.path));
  const untested = records.flatMap((record) => record.functions.filter((fn) => !fn.hits && isCoreApi(fn)).map((fn) => ({ ...fn, path: record.path })));
  const lines = [header, recipients, "", `**${label}**`, "", "| Measure | Covered | Missed | Coverage |", "| --- | ---: | ---: | ---: |", `| Lines | ${hit}/${found} | ${found - hit} | ${found ? ((100 * hit) / found).toFixed(2) : "0.00"}% |`, `| Functions | ${functionsHit}/${functionsFound} | ${functionsFound - functionsHit} | ${functionsFound ? ((100 * functionsHit) / functionsFound).toFixed(2) : "0.00"}% |`, ""];
  if (gaps.length) {
    lines.push(`### Source files below ${LOW_COVERAGE_PERCENT}% line coverage`, "", "| File | Lines | Missed line ranges |", "| --- | ---: | --- |");
    lines.push(...gaps.map((record) => `| \`${record.path}\` | ${record.hit}/${record.found} (${record.percent.toFixed(2)}%) | ${formatLineRanges(record.missedLines)} |`));
  } else {
    lines.push("All measured files meet the coverage floor.");
  }
  if (untested.length) {
    lines.push("", `### Untested Core APIs (${untested.length})`, "", "| Source line | API |", "| ---: | --- |");
    lines.push(...untested.slice(0, MAX_UNTESTED_APIS).map((fn) => `| ${fn.line} | \`${fn.name}\` |`));
    if (untested.length > MAX_UNTESTED_APIS) lines.push(`| — | …and ${untested.length - MAX_UNTESTED_APIS} more in the coverage artifact |`);
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
