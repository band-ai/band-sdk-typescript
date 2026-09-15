import { API_STATUS } from "./core-api-coverage-schema.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkDirectory = fileURLToPath(new URL("../../packages/sdk/", import.meta.url));
const requireFromSdk = createRequire(join(sdkDirectory, "package.json"));
const ts = requireFromSdk("typescript");

function parseSource(name, text, kind) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${name}`);
  return source;
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function memberName(node) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const prefix = ts.isGetAccessor(node) ? "get " : ts.isSetAccessor(node) ? "set " : "";
  return `${hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static " : ""}${prefix}${node.name.getText()}`;
}

function publicApis(source) {
  const apis = new Map();
  const add = (group, name) => apis.set(`${group}.${name}`, { group, name });
  for (const node of source.statements) {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node)) add("Functions", node.name.text);
    else if (ts.isClassDeclaration(node)) {
      if (node.heritageClauses?.length) throw new Error(`Inherited API needs mapping: ${node.name.text}`);
      for (const member of node.members) {
        if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
        if (ts.isPropertyDeclaration(member)) {
          const prefix = hasModifier(member, ts.SyntaxKind.StaticKeyword) ? "static " : "";
          add(node.name.text, `${prefix}get ${member.name.getText()}`);
          if (!hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)) add(node.name.text, `${prefix}set ${member.name.getText()}`);
        } else if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
          add(node.name.text, memberName(member));
        } else throw new Error(`Unsupported public member: ${member.getText()}`);
      }
    } else if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) {
      throw new Error(`Unsupported public declaration: ${node.getText()}`);
    }
  }
  if (!apis.size) throw new Error("No public Core APIs found");
  return [...apis.values()];
}

export function buildApiCoverage({ declarations, javascript, coverage, version }) {
  const source = parseSource("band_sdk_core.js", javascript, ts.ScriptKind.JS);
  const implementations = new Map();
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node)) implementations.set(`Functions.${node.name.text}`, node);
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (member.body) implementations.set(`${node.name.text}.${memberName(member)}`, member);
      }
    }
  }
  const apis = publicApis(parseSource("index.d.ts", declarations, ts.ScriptKind.TS)).map((api) => {
    const implementation = implementations.get(`${api.group}.${api.name}`);
    if (!implementation) return { ...api, status: API_STATUS.UNMAPPED, reason: "No matching JavaScript implementation" };
    const start = hasModifier(implementation, ts.SyntaxKind.StaticKeyword) ? implementation.name.getStart(source) : implementation.getStart(source);
    const position = source.getLineAndCharacterOfPosition(start);
    const line = position.line + 1;
    // Function names repeat across classes; only source locations identify an API.
    const matches = Object.entries(coverage.fnMap).filter(([, fn]) => fn.loc.start.line === line && fn.loc.start.column === position.character);
    if (matches.length !== 1) return { ...api, line, status: API_STATUS.UNMAPPED, reason: "No unique coverage function at source location" };
    const hits = coverage.f[matches[0][0]];
    if (!Number.isFinite(hits) || hits < 0) throw new Error(`Invalid coverage hits for ${api.group}.${api.name}`);
    return { ...api, line, hits, status: hits > 0 ? API_STATUS.EXERCISED : API_STATUS.UNEXERCISED };
  });
  return { version, sourceSha256: createHash("sha256").update(javascript).digest("hex"), apis };
}

async function main() {
  const reportDirectory = resolve(process.argv[2]);
  const gluePath = await realpath(requireFromSdk.resolve("@band-ai/band-sdk-core"));
  const summary = JSON.parse(await readFile(join(reportDirectory, "coverage-summary.json"), "utf8"));
  if (!summary[gluePath]) throw new Error("Installed Core does not match the measured coverage source");
  execFileSync("pnpm", ["exec", "c8", "report", "-r", "json", "--temp-directory", join(dirname(reportDirectory), "v8"), "--allow-external", "--exclude-node-modules=false", "--include", gluePath, "--reports-dir", reportDirectory], { cwd: sdkDirectory, stdio: "inherit" });
  const coverage = JSON.parse(await readFile(join(reportDirectory, "coverage-final.json"), "utf8"))[gluePath];
  if (!coverage) throw new Error("No function coverage for installed Core");
  const packageDirectory = dirname(gluePath);
  const manifest = buildApiCoverage({
    declarations: await readFile(join(packageDirectory, "index.d.ts"), "utf8"),
    javascript: await readFile(gluePath, "utf8"),
    coverage,
    version: JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")).version,
  });
  await writeFile(join(reportDirectory, "api-coverage.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (manifest.apis.some((api) => api.status === API_STATUS.UNMAPPED)) throw new Error("Some public Core APIs could not be mapped; see api-coverage.json");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
