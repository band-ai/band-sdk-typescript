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

function coverageMarker(hit, total) {
  const value = total ? 100 * hit / total : 0;
  if (value >= 80) return "🟢";
  if (value >= 50) return "🟠";
  return "🔴";
}

function apiNames(apis, limit = 5) {
  const names = apis.slice(0, limit).map((api) => `\`${api.name}\``).join(", ");
  return apis.length > limit ? `${names} +${apis.length - limit} more` : names;
}

function apiGroups(apis) {
  return [...Map.groupBy(apis, (api) => api.group)].sort(([left, a], [right, b]) => {
    const rate = (items) => items.filter((api) => api.status === API_STATUS.EXERCISED).length / items.length;
    return rate(a) - rate(b) || b.length - a.length || left.localeCompare(right);
  });
}

export function renderDigest({ lcov, apiCoverage, label, recipients, runUrl, result }) {
  const lines = ["## 📊 Weekly Core coverage", "", recipients, "", `**${label}**`, ""];
  if (!lcov) return [...lines, `⚠️ **Coverage unavailable** · workflow \`${result}\``, "", "No coverage report was produced. Open the run for failure details.", "", `[Open run →](${runUrl})`].join("\n");
  const records = parseLcov(lcov);
  const sum = (key) => records.reduce((total, record) => total + record[key], 0);
  if (apiCoverage?.apis?.length) {
    const apis = apiCoverage.apis;
    const exercised = apis.filter((api) => api.status === API_STATUS.EXERCISED).length;
    const missing = apis.filter((api) => api.status === API_STATUS.UNEXERCISED).length;
    const unmapped = apis.filter((api) => api.status === API_STATUS.UNMAPPED).length;
    lines.push("### Coverage snapshot", "",
      "| Signal | Result |", "| --- | --- |",
      `| Public APIs | ${coverageMarker(exercised, apis.length)} **${percent(exercised, apis.length)}** · ${exercised}/${apis.length} exercised · ${missing} missing |`,
      `| Glue lines | ${coverageMarker(sum("hit"), sum("found"))} **${percent(sum("hit"), sum("found"))}** · ${sum("hit")}/${sum("found")} covered |`,
      `| Glue functions | ${coverageMarker(sum("functionsHit"), sum("functionsFound"))} **${percent(sum("functionsHit"), sum("functionsFound"))}** · ${sum("functionsHit")}/${sum("functionsFound")} covered |`, "");
    if (unmapped) lines.push(`⚠️ **${unmapped} public APIs could not be mapped.** The measurement is incomplete.`, "");
    lines.push("### 🎯 Where to focus", "",
      "| Core component | Public API exercise |", "| --- | --- |");
    for (const [group, members] of apiGroups(apis)) {
      const hit = members.filter((api) => api.status === API_STATUS.EXERCISED).length;
      const absent = members.filter((api) => api.status === API_STATUS.UNEXERCISED);
      if (absent.length) lines.push(`| ${group} | ${coverageMarker(hit, members.length)} **${percent(hit, members.length)}** · ${hit}/${members.length} exercised · ${absent.length} missing |`);
    }
    const priorities = apiGroups(apis).filter(([, members]) => members.some((api) => api.status === API_STATUS.UNEXERCISED)).slice(0, 6);
    lines.push("", "### Missing APIs at a glance", "");
    for (const [group, members] of priorities) {
      const absent = members.filter((api) => api.status === API_STATUS.UNEXERCISED);
      lines.push(`- **${group}:** ${apiNames(absent)}`);
    }
    const coveredGroups = apiGroups(apis).map(([group, members]) => [group, members.filter((api) => api.status === API_STATUS.EXERCISED)]).filter(([, members]) => members.length);
    lines.push("", "### ✅ Exercised Core surface", "",
      "| Core component | APIs called by the SDK tests |", "| --- | --- |");
    for (const [group, members] of coveredGroups) lines.push(`| ${group} | ${apiNames(members, 8)} |`);
    lines.push("", `Core ${apiCoverage.version}. “Exercised” means called at least once; it does not prove every behavior or branch. Unexercised does not mean unused in production.`, "");
  } else lines.push("**Public API coverage unavailable.** The API manifest was not produced; generated JavaScript totals cannot identify API gaps.", "");
  lines.push("_Glue metrics describe generated JavaScript. Rust/WASM implementation coverage is outside this report._", "",
    `[View the run and full API/HTML coverage artifact →](${runUrl}#artifacts)`);
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
