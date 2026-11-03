import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { BuildError, buildSites, DEFAULT_OUT_DIR } from './build.js';
import { ConfigError, loadConfig } from './config.js';
import { HomeError } from './content/home.js';
import { PostError } from './content/posts.js';
import { MarkdownError } from './markdown/render.js';
import { I18nError } from './render/i18n.js';
import { DEFAULT_PORT, startServer } from './serve.js';
import { readVersion } from './version.js';

export { readVersion };

export const USAGE = `Usage: coffer <command> [options]

Commands:
  build           Build the sites into an output directory
                  (--config <path>, --out <dir> [default: ${DEFAULT_OUT_DIR}],
                  --drafts to include drafts and future posts, --now <date>)
  serve [dir]     Serve one built site directory the way Cloudflare Pages does
                  (--port <number> [default: ${DEFAULT_PORT}], --host <address>;
                  dir defaults to the working directory)
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

/**
 * Reads the options of `coffer build`.
 *
 * @param {string[]} args
 * @returns {{ configPath?: string, out?: string, drafts: boolean, now?: string } | { error: string }}
 */
export function parseBuildArgs(args) {
  /** @type {{ configPath?: string, out?: string, drafts: boolean, now?: string }} */
  const options = { drafts: false };
  /** @type {Record<string, 'configPath' | 'out' | 'now'>} */
  const valued = { '--config': 'configPath', '--out': 'out', '--now': 'now' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--drafts') {
      options.drafts = true;
      continue;
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (!Object.hasOwn(valued, flag)) return { error: `unexpected argument "${arg}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    options[valued[flag]] = value;
  }
  return options;
}

/**
 * Reads the options of `coffer serve`.
 *
 * @param {string[]} args
 * @returns {{ dir: string, port: number, host?: string } | { error: string }}
 */
export function parseServeArgs(args) {
  /** @type {{ dir: string, port: number, host?: string }} */
  const options = { dir: '.', port: DEFAULT_PORT };
  let sawDir = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (sawDir) return { error: `unexpected argument "${arg}"` };
      options.dir = arg;
      sawDir = true;
      continue;
    }
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (flag !== '--port' && flag !== '--host') return { error: `unexpected argument "${arg}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    if (flag === '--host') {
      options.host = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) > 65535) {
        return { error: '--port must be a number from 0 to 65535' };
      }
      options.port = Number(value);
    }
  }
  return options;
}

/** @type {Record<string, Command>} */
const commands = {
  serve: async (args, io) => {
    const parsed = parseServeArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}
`);
      return 1;
    }
    const dir = resolve(parsed.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      io.err(`coffer: ${parsed.dir} is not a directory
`);
      return 1;
    }
    let running;
    try {
      running = await startServer({ dir, port: parsed.port, host: parsed.host });
    } catch (error) {
      io.err(`coffer: cannot start the server: ${error instanceof Error ? error.message : error}
`);
      return 1;
    }
    io.out(`Serving ${dir} at ${running.url}/ (Ctrl+C to stop)
`);
    const { server } = running;
    process.once('SIGINT', () => void running.close());
    process.once('SIGTERM', () => void running.close());
    await new Promise((done) => server.once('close', done));
    return 0;
  },
  build: async (args, io) => {
    const parsed = parseBuildArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    try {
      const config = loadConfig({ configPath: parsed.configPath });
      const results = await buildSites(config, {
        out: parsed.out,
        drafts: parsed.drafts,
        nowFlag: parsed.now,
      });
      for (const result of results) {
        for (const warning of result.warnings) {
          io.err(`warning: ${result.id}: ${warning}\n`);
        }
        const { posts, pages } = result.manifest;
        io.out(
          `${result.id}: ${posts.length} post(s), ${pages.length} page(s) -> ${result.outDir}\n`,
        );
      }
      return 0;
    } catch (error) {
      if (
        error instanceof ConfigError ||
        error instanceof PostError ||
        error instanceof HomeError
      ) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      if (
        error instanceof BuildError ||
        error instanceof MarkdownError ||
        error instanceof I18nError
      ) {
        io.err(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  },
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
