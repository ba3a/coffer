import { readFileSync } from 'node:fs';

export const USAGE = `Usage: coffer <command> [options]

Commands:
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

/** @type {Record<string, Command>} */
const commands = {
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
