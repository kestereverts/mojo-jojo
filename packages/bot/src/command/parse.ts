/** A parsed command invocation. */
export interface ParsedCommand {
  /** Command word, lowercased (plain ASCII — command names are not nicks/channels). */
  readonly name: string;
  /** Whitespace-split arguments. */
  readonly args: readonly string[];
  /** Raw remainder after the command word, with internal spacing preserved. */
  readonly argLine: string;
}

const LEADING_WS = /^\s+/;
const COMMAND = /^(\S+)(?:\s+([\s\S]*))?$/;

/**
 * Parse a message into a command. With `requirePrefix`, the text must start with
 * `prefix` (else `null`); without it (a PM, when allowed), the prefix is stripped
 * if present but not required. Returns `null` when there is no command word.
 */
export function parseCommandLine(
  prefix: string,
  text: string,
  opts: { requirePrefix: boolean },
): ParsedCommand | null {
  let rest = text;
  if (rest.startsWith(prefix)) {
    rest = rest.slice(prefix.length);
  } else if (opts.requirePrefix) {
    return null;
  }

  const trimmed = rest.replace(LEADING_WS, "");
  const match = COMMAND.exec(trimmed);
  if (!match) return null;

  const name = match[1]!.toLowerCase();
  const argLine = match[2] ?? "";
  const args = argLine.length === 0 ? [] : argLine.split(/\s+/).filter((a) => a.length > 0);
  return { name, args, argLine };
}
