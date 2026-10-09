import type { Env } from "./config";

/** How a channel option names Band's plugin, whatever marketplace it came from. */
export const BAND_CHANNEL_ENTRY = "plugin:band@";

const CHANNELS_OPTION = "--channels";
const DEV_CHANNELS_OPTION = "--dangerously-load-development-channels";
/** The Claude Code options whose entries turn channels on. */
const CHANNEL_OPTIONS = [CHANNELS_OPTION, DEV_CHANNELS_OPTION];
/** Claude Code's non-interactive mode, which ignores development channels. */
const PRINT_OPTIONS = ["-p", "--print"];
/** Band's plugin as its marketplace publishes it. */
const BAND_PLUGIN = `${BAND_CHANNEL_ENTRY}band-ai`;
/** Set when Claude Code runs servers through a wrapper, which is then the server's parent. */
const SHELL_PREFIX_ENV = "CLAUDE_CODE_SHELL_PREFIX";
const OPTION_PREFIX = "-";
/** Ends the options: what follows is the prompt, even where it looks like an option. */
const END_OF_OPTIONS = "--";

/** How to start Claude Code with Band's channel on. */
export const LAUNCH_COMMANDS =
  `\`claude ${CHANNELS_OPTION} ${BAND_PLUGIN}\`, or \`claude ${DEV_CHANNELS_OPTION} ${BAND_PLUGIN}\` where channels aren't enabled`;

/**
 * Whether Claude Code started this server's session with Band's channel. When in doubt, on: a command line
 * that can't be read, or one that belongs to a wrapper rather than Claude Code.
 */
export function bandChannelOn(parentArgs: readonly string[] | undefined, env: Env): boolean {
  if (parentArgs === undefined || env[SHELL_PREFIX_ENV]) {
    return true;
  }
  const enabled = enabledOptions(parentArgs);
  return enabled.has(CHANNELS_OPTION) || (!PRINT_OPTIONS.some((option) => enabled.has(option)) && enabled.has(DEV_CHANNELS_OPTION));
}

// Claude Code 2.1.295's required-value declarations, including aliases and hidden options.
// Their first value consumes the next argv even when it looks like another option.
const REQUIRED_VALUE_OPTIONS = new Set([
  "--debug-file", "--output-format", "--json-schema", "--input-format", "--thinking", "--thinking-display",
  "--max-thinking-tokens", "--max-turns", "--max-budget-usd", "--task-budget", "--permission-prompt-tool", "--permission-prompts",
  "--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file", "--system-prompt-snapshot",
  "--append-subagent-system-prompt", "--append-subagent-system-prompt-file", "--plan-mode-instructions", "--permission-mode", "--inherit-permission-mode",
  "--watch-artifact", "--watch-artifact-no-autoreact", "--prefill", "--deep-link-repo", "--deep-link-last-fetch", "--prefill-b64", "--deep-link-cwd-b64",
  "--resume-session-at", "--resume-drops-turn", "--rewind-files", "--model", "--effort", "--agent", "--fallback-model", "--workload",
  "--settings", "--client-data-url", "--managed-settings", "--project-config-root", "--session-id", "-n", "--name", "--agents", "--setting-sources",
  "--plugin-dir", "--plugin-dir-no-mcp", "--plugin-url", "--advisor", "--autocompact", "--proactivity", "--messaging-socket-path",
  "--agent-id", "--agent-name", "--team-name", "--agent-color", "--parent-session-id", "--teammate-mode", "--agent-type", "--sdk-url",
  "--forward-home-settings", "--attach-serve", "--environment", "--pool", "--correlation-id", "--ref", "--on-branch", "--remote-control-session-name-prefix",
  "--allowedTools", "--allowed-tools", "--tools", "--disallowedTools", "--disallowed-tools", "--mcp-config", "--betas", "--add-dir", "--file",
]);

/** Reads channel and print options while keeping values owned by their declaring option. */
function enabledOptions(args: readonly string[]): Set<string> {
  const enabled = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === END_OF_OPTIONS) {
      break;
    }
    const [option, value] = splitOption(arg);
    if (PRINT_OPTIONS.includes(option)) {
      enabled.add(option);
    } else if (CHANNEL_OPTIONS.includes(option)) {
      // The = form takes one value; the variadic form consumes its first value unconditionally.
      const entries = value === undefined ? [args[++index]] : [value];
      if (value === undefined) {
        while (index + 1 < args.length && !args[index + 1].startsWith(OPTION_PREFIX)) {
          entries.push(args[++index]);
        }
      }
      if (entries.some((entry) => entry?.startsWith(BAND_CHANNEL_ENTRY))) {
        enabled.add(option);
      }
    } else if (value === undefined && REQUIRED_VALUE_OPTIONS.has(option)) {
      index++;
    }
  }
  return enabled;
}

function splitOption(arg: string): [string, string | undefined] {
  const equals = arg.indexOf("=");
  return equals < 0 ? [arg, undefined] : [arg.slice(0, equals), arg.slice(equals + 1)];
}
