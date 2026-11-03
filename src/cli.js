import { readFileSync } from 'node:fs';

import { ConfigError, loadConfig } from './config.js';

export const USAGE = `Usage: coffer <command> [options]

Commands:
  config          Check coffer.yaml and list the configured sites
                  (--config <path> selects another file)
  help            Show this help text
  --version, -v   Print the coffer version

Run "coffer help" to see this message again.
`;

/**
 * @typedef {object} Io
 * @property {(text: string) => void} out Writes to standard output.
 * @property {(text: string) => void} err Writes to standard error.
 */

/**
 * A command receives its arguments (without the command name) and the output
 * channels, and resolves to a process exit code.
 *
 * @typedef {(args: string[], io: Io) => number | Promise<number>} Command
 */

/**
 * Reads the engine version from the package manifest.
 *
 * @returns {string}
 */
export function readVersion() {
  const manifest = new URL('../package.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  return String(parsed.version);
}

/**
 * Extracts the value of `--config <path>` or `--config=<path>`.
 *
 * @param {string[]} args
 * @returns {{ configPath?: string } | { error: string }}
 */
export function parseConfigArgs(args) {
  /** @type {string | undefined} */
  let configPath;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--config') {
      const value = args[i + 1];
      if (value === undefined || value === '') {
        return { error: '--config needs a path' };
      }
      configPath = value;
      i += 1;
    } else if (arg.startsWith('--config=') && arg.length > '--config='.length) {
      configPath = arg.slice('--config='.length);
    } else {
      return { error: `unexpected argument "${arg}"` };
    }
  }
  return configPath === undefined ? {} : { configPath };
}

/** @type {Record<string, Command>} */
const commands = {
  config: (args, io) => {
    const parsed = parseConfigArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    try {
      const config = loadConfig(parsed);
      const names = config.sites.map((site) => site.id).join(', ');
      io.out(`${config.sites.length} site(s) configured: ${names}\n`);
      return 0;
    } catch (error) {
      if (error instanceof ConfigError) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      throw error;
    }
  },
  help: (_args, io) => {
    io.out(USAGE);
    return 0;
  },
  '--help': (_args, io) => {
    io.out(USAGE);
    return 0;
  },
  '-h': (_args, io) => {
    io.out(USAGE);
    return 0;
  },
  '--version': (_args, io) => {
    io.out(`${readVersion()}\n`);
    return 0;
  },
  '-v': (_args, io) => {
    io.out(`${readVersion()}\n`);
    return 0;
  },
};

/**
 * Dispatches a command line to the matching command.
 *
 * @param {string[]} argv Arguments after the program name.
 * @param {Io} io Output channels.
 * @returns {Promise<number>} Process exit code.
 */
export async function run(argv, io) {
  const [name, ...args] = argv;
  if (name === undefined) {
    io.err(USAGE);
    return 1;
  }
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (command === undefined) {
    io.err(`coffer: unknown command "${name}"\n\n${USAGE}`);
    return 1;
  }
  return command(args, io);
}
