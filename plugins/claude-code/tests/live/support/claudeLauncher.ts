/**
 * Claude Code's place in the process tree: started as
 * `node claudeLauncher.ts [--channels plugin:band@inline] -- <command> [args…]`, it runs the plugin's server as
 * its child on its own stdio, so the server's channel check reads this command line as it would Claude Code's.
 * Node runs it as is, stripping its types, so it uses no syntax beyond them.
 */
import { spawn } from "node:child_process";

const END_OF_OPTIONS = "--";
const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

const [command, ...args] = process.argv.slice(process.argv.indexOf(END_OF_OPTIONS) + 1);
const server = spawn(command, args, { stdio: "inherit" });
for (const signal of STOP_SIGNALS) {
  process.on(signal, () => server.kill(signal));
}
server.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
