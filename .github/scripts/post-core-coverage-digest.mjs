import { API_STATUS } from "./core-api-coverage-schema.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function parseLcov(text) {
  return text.split("end_of_record").filter((record) => /^SF:/m.test(record)).map((record) => {
    const count = (field) => Number(record.match(new RegExp(`^${field}:(\\d+)$`, "m"))?.[1] ?? 0);
    return { found: count("LF"), hit: count("LH"), functionsFound: count("FNF"), functionsHit: count("FNH") };
  });
}

function percent(hit, total) {
  return total ? `${(100 * hit / total).toFixed(2)}%` : "N/A";
}

function apiGroups(apis) {
  return [...Map.groupBy(apis, (api) => api.group)].sort(([left, a], [right, b]) => {
    const rate = (items) => items.filter((api) => api.status === API_STATUS.EXERCISED).length / items.length;
    return rate(a) - rate(b) || left.localeCompare(right);
  });
}

export function renderDigest({ lcov, apiCoverage, label, recipients, runUrl, result }) {
  const lines = ["## Weekly Core coverage report", "", recipients, "", `**${label}**`, "", `Workflow: **${result}**`, ""];
  if (!lcov) return [...lines, "No coverage report was produced. Coverage is unavailable.", "", `[Open run](${runUrl})`].join("\n");
  if (apiCoverage?.apis?.length) {
    const apis = apiCoverage.apis;
    const exercised = apis.filter((api) => api.status === API_STATUS.EXERCISED).length;
    const missing = apis.filter((api) => api.status === API_STATUS.UNEXERCISED).length;
    const unmapped = apis.filter((api) => api.status === API_STATUS.UNMAPPED).length;
    lines.push(`### Public API exercise coverage · ${percent(exercised, apis.length)}`, "",
      `**${exercised} exercised** · **${missing} unexercised** · **${unmapped} unmapped** · ${apis.length} total`, "",
      `Core ${apiCoverage.version}. “Exercised” means called at least once by this test run; it does not prove every behavior or branch was tested. Unexercised does not mean unused in production.`, "",
      "| Core component | Exercised / total | API coverage |", "| --- | ---: | ---: |");
    for (const [group, members] of apiGroups(apis)) {
      const hit = members.filter((api) => api.status === API_STATUS.EXERCISED).length;
      lines.push(`| ${group} | ${hit} / ${members.length} | ${percent(hit, members.length)} |`);
    }
    lines.push("", "### What was exercised and what is missing", "");
    for (const [group, members] of apiGroups(apis)) {
      lines.push(`**${group}**`, "");
      for (const [status, title] of [[API_STATUS.UNEXERCISED, "Unexercised"], [API_STATUS.EXERCISED, "Exercised"], [API_STATUS.UNMAPPED, "Unmapped — measurement incomplete"]]) {
        const names = members.filter((api) => api.status === status).map((api) => `\`${api.name}\``);
        if (names.length) lines.push(`- ${title}: ${names.join(", ")}`);
      }
      lines.push("");
    }
  } else lines.push("**Public API coverage unavailable.** The API manifest was not produced; generated JavaScript totals cannot identify API gaps.", "");
  const records = parseLcov(lcov);
  const sum = (key) => records.reduce((total, record) => total + record[key], 0);
  lines.push("### Generated JavaScript diagnostics", "", "These measure wasm-bindgen glue. Rust/WASM implementation coverage is not measured by this report.", "",
    "| Measure | Covered / total | Coverage |", "| --- | ---: | ---: |",
    `| Lines | ${sum("hit")} / ${sum("found")} | ${percent(sum("hit"), sum("found"))} |`,
    `| Functions (including generated helpers) | ${sum("functionsHit")} / ${sum("functionsFound")} | ${percent(sum("functionsHit"), sum("functionsFound"))} |`, "",
    `[Open run and full coverage artifact](${runUrl}#artifacts)`);
  return lines.join("\n");
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function main() {
  const lcov = await readOptional(process.env.LCOV_PATH);
  const manifest = await readOptional(join(dirname(process.env.LCOV_PATH), "api-coverage.json"));
  const body = renderDigest({ lcov, apiCoverage: manifest ? JSON.parse(manifest) : undefined,
    label: process.env.REPORT_LABEL, recipients: process.env.RECIPIENTS,
    runUrl: process.env.RUN_URL, result: process.env.WORKFLOW_RESULT });
  const result = spawnSync("gh", ["api", `repos/${process.env.REPO}/commits/${process.env.SHA}/comments`, "--method", "POST", "-f", `body=${body}`], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
