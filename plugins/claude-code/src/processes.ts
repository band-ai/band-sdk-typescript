import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 0, ending a walk up the process tree, where `ps` can't tell (Windows has none). */
export function parentPid(pid: number): number {
  try {
    return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

/** The original argument vector; none where the OS cannot expose it. `ps` loses argument boundaries. */
export function processArgs(pid: number): readonly string[] | undefined {
  try {
    if (process.platform === "linux") {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw ? raw.slice(0, -1).split("\0") : undefined;
    }
    return process.platform === "darwin" ? darwinArgs(pid) : undefined;
  } catch {
    return undefined;
  }
}

// Apple's sys/sysctl.h: CTL_KERN / KERN_PROCARGS2 returns argc, executable, padding, then NUL-separated argv.
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
const NATIVE_INT_BYTES = Int32Array.BYTES_PER_ELEMENT;

function darwinArgs(pid: number): string[] {
  const identifiers = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
  const mib = Buffer.from(identifiers.buffer).toString("base64");
  // JXA exposes the native syscall without shipping a compiled helper or requiring developer tools.
  const script = `
ObjC.import('Foundation');
ObjC.bindFunction('sysctl', ['int', ['void *', 'unsigned int', 'void *', 'unsigned long *', 'void *', 'unsigned long']]);
var size = Ref();
var mib = $.NSData.alloc.initWithBase64EncodedStringOptions('${mib}', 0);
if ($.sysctl(mib.bytes, ${identifiers.length}, null, size, null, 0) !== 0) throw new Error('Cannot read process argument size');
var data = $.NSMutableData.dataWithLength(Number(size[0]));
if ($.sysctl(mib.bytes, ${identifiers.length}, data.mutableBytes, size, null, 0) !== 0) throw new Error('Cannot read process arguments');
ObjC.unwrap(data.base64EncodedStringWithOptions(0));
`;
  const raw = Buffer.from(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), "base64");
  const argc = raw.readInt32LE(0);
  let offset = raw.indexOf(0, NATIVE_INT_BYTES);
  if (offset < 0 || argc <= 0) {
    throw new Error("Invalid process arguments");
  }
  while (raw[++offset] === 0) { /* Skip executable padding. */ }
  const args: string[] = [];
  for (let i = 0; i < argc; i++) {
    const end = raw.indexOf(0, offset);
    if (end < 0) {
      throw new Error("Incomplete process arguments");
    }
    args.push(raw.toString("utf8", offset, end));
    offset = end + 1;
  }
  return args;
}
