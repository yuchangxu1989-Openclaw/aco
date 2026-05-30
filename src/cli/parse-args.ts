/**
 * CLI 参数解析工具
 */

export interface ParsedArgs {
  command: string | undefined;
  args: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    args: positional.slice(1),
    flags,
  };
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(`--${flag}`);
}

export function getFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(`--${flag}`);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  const val = argv[idx + 1];
  if (val.startsWith('--')) return undefined;
  return val;
}
