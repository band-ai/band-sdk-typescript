import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";

const [claude, letta, opencode] = process.argv.slice(2);
if (!claude || !letta || !opencode) throw new Error("Pass the extracted Claude, Letta and OpenCode package directories");
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = resolve(root, "tests/fixtures/activityPeerContracts.ts");
const entries = [
  ["@anthropic-ai/claude-agent-sdk", resolve(claude, "sdk.d.ts")],
  ["@letta-ai/letta-client/client", resolve(letta, "client.d.ts")],
  ["@letta-ai/letta-client/resources/agents/messages", resolve(letta, "resources/agents/messages.d.ts")],
  ["@opencode-ai/sdk/v2", resolve(opencode, "dist/v2/client.d.ts")],
];
let source = readFileSync(fixture, "utf8");
for (const [name, path] of entries) source = source.replace(JSON.stringify(name), JSON.stringify(path));
const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const host = ts.createCompilerHost(options);
const original = host.getSourceFile;
host.getSourceFile = (name, version, ...args) => name === fixture ? ts.createSourceFile(name, source, version, true) : original(name, version, ...args);
const program = ts.createProgram([fixture], { ...options, rootDir: root, noEmit: true }, host);
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => "\n",
  }));
}
console.log("Activity peer contracts passed against supplied published packages");
