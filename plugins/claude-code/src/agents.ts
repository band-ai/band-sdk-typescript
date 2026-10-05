import { runAgentsCommand } from "./agentCommands";

// The `/band:agents` skill shows stdout as is, and stderr when the command fails.
try {
  process.stdout.write(`${await runAgentsCommand(process.argv.slice(2))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
