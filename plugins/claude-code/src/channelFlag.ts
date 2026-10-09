import type { Env } from "./config";

/** How a channel option names Band's plugin, whatever marketplace it came from. */
export const BAND_CHANNEL_ENTRY = "plugin:band@";

const CHANNELS_OPTION = "--channels";
const DEV_CHANNELS_OPTION = "--dangerously-load-development-channels";
/** The Claude Code options whose entries turn channels on. */
const CHANNEL_OPTIONS = [CHANNELS_OPTION, DEV_CHANNELS_OPTION];
/** Band's plugin as its marketplace publishes it. */
const BAND_PLUGIN = `${BAND_CHANNEL_ENTRY}band-ai`;
/** Set when Claude Code runs servers through a wrapper, which is then the server's parent. */
const SHELL_PREFIX_ENV = "CLAUDE_CODE_SHELL_PREFIX";
const OPTION_PREFIX = "-";

/** How to start Claude Code with Band's channel on. */
export const LAUNCH_COMMANDS =
  `\`claude ${CHANNELS_OPTION} ${BAND_PLUGIN}\`, or \`claude ${DEV_CHANNELS_OPTION} ${BAND_PLUGIN}\` where channels aren't enabled`;

/**
 * Whether Claude Code started this server's session with Band's channel. When in doubt, on: a command line
 * that can't be read, or one that belongs to a wrapper rather than Claude Code.
 */
export function bandChannelOn(parentCommandLine: string | undefined, env: Env): boolean {
  if (parentCommandLine === undefined || env[SHELL_PREFIX_ENV]) {
    return true;
  }
  return channelEntries(parentCommandLine.split(/\s+/)).some((entry) => entry.startsWith(BAND_CHANNEL_ENTRY));
}

/** Each entry of a channel option: the arguments after it up to the next option, or the one value of `--option=value`, as commander parses them. */
function channelEntries(args: readonly string[]): string[] {
  const entries: string[] = [];
  let inOption = false;
  for (const arg of args) {
    if (arg.startsWith(OPTION_PREFIX)) {
      const [option, value] = splitOption(arg);
      const isChannelOption = CHANNEL_OPTIONS.includes(option);
      if (isChannelOption && value !== undefined) {
        entries.push(value);
      }
      inOption = isChannelOption && value === undefined;
    } else if (inOption) {
      entries.push(arg);
    }
  }
  return entries;
}

function splitOption(arg: string): [string, string | undefined] {
  const equals = arg.indexOf("=");
  return equals < 0 ? [arg, undefined] : [arg.slice(0, equals), arg.slice(equals + 1)];
}
