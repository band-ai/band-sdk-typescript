import { execFileSync } from "node:child_process";

/** 0, ending a walk up the process tree, where `ps` can't tell (Windows has none). */
export function parentPid(pid: number): number {
  try {
    return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

/** The command line process `pid` was started with; none where `ps` can't tell. */
export function commandLine(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}
