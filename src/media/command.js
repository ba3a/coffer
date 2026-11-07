import { ConfigError, loadConfig } from '../config.js';
import { MissingCredentialsError } from './credentials.js';
import { LockError } from './lock.js';
import { MediaStoreError } from './store.js';
import { createStore } from './stores.js';
import {
  formatLock,
  formatPull,
  formatPush,
  formatStatus,
  gitignoreText,
  lockMedia,
  MediaError,
  mediaContext,
  mediaStatus,
  pullMedia,
  pushMedia,
} from './sync.js';

/**
 * `coffer media <subcommand>`: the command line of the media store.
 */

/** The exit code of a command that was called wrongly; 1 is a conflict or a failure. */
const EXIT_USAGE = 2;

/** The subcommands and the flags each accepts besides `--config`. */
export const MEDIA_SUBCOMMANDS = Object.freeze({
  status: Object.freeze(['--remote']),
  lock: Object.freeze([]),
  push: Object.freeze([]),
  pull: Object.freeze(['--force', '--restore', '--dry-run']),
  gitignore: Object.freeze([]),
});

/**
 * Reads the arguments of a media subcommand.
 *
 * @param {string[]} args The arguments after `media`.
 * @returns {{ subcommand: keyof typeof MEDIA_SUBCOMMANDS, configPath?: string, flags: Set<string> } | { error: string }}
 */
export function parseMediaArgs(args) {
  const [subcommand, ...rest] = args;
  const known = Object.keys(MEDIA_SUBCOMMANDS).join(', ');
  if (subcommand === undefined || subcommand.startsWith('-')) return { error: `media needs a subcommand (${known})` };
  if (!Object.hasOwn(MEDIA_SUBCOMMANDS, subcommand)) return { error: `unknown media subcommand "${subcommand}" (known: ${known})` };
  const name = /** @type {keyof typeof MEDIA_SUBCOMMANDS} */ (subcommand);
  const allowed = MEDIA_SUBCOMMANDS[name];
  /** @type {string | undefined} */
  let configPath;
  /** @type {Set<string>} */
  const flags = new Set();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--config') {
      const value = rest[i + 1];
      if (value === undefined || value === '') return { error: '--config needs a path' };
      if (value.startsWith('-')) return { error: `--config needs a path, but "${value}" looks like an option (write --config=${value} if that really is the path)` };
      configPath = value;
      i += 1;
    } else if (arg.startsWith('--config=') && arg.length > '--config='.length) {
      configPath = arg.slice('--config='.length);
    } else if (/** @type {readonly string[]} */ (allowed).includes(arg)) {
      flags.add(arg);
    } else {
      return { error: `unexpected argument "${arg}" for "media ${name}"` };
    }
  }
  return configPath === undefined ? { subcommand: name, flags } : { subcommand: name, configPath, flags };
}

/**
 * @param {string[]} args The arguments after `media`.
 * @param {import('../cli.js').Io} io
 * @param {{ env?: Record<string, string | undefined> }} services
 * @returns {Promise<number>} The exit code.
 */
export async function runMedia(args, io, services) {
  const parsed = parseMediaArgs(args);
  if ('error' in parsed) {
    io.err(`coffer: ${parsed.error}\n`);
    return EXIT_USAGE;
  }
  try {
    const config = loadConfig({ configPath: parsed.configPath });
    const context = mediaContext(config);
    const storeContext = { env: services.env, configDir: config.dir, warn: (/** @type {string} */ message) => io.err(`coffer: warning: ${message}\n`) };
    switch (parsed.subcommand) {
      case 'gitignore':
        io.out(gitignoreText(context));
        return 0;
      case 'lock': {
        io.out(formatLock(await lockMedia(context), context.media.lock));
        return 0;
      }
      case 'status': {
        const store = parsed.flags.has('--remote') ? await createStore(context.media.store, storeContext) : undefined;
        io.out(formatStatus(await mediaStatus(context, { store })));
        return 0;
      }
      case 'push': {
        // An empty or missing lock needs no store, so it needs no credentials either.
        const result = await pushMedia(context, () => createStore(context.media.store, storeContext));
        const text = formatPush(result);
        if (result.errors.length > 0) {
          io.err(text);
          return 1;
        }
        io.out(text);
        return 0;
      }
      case 'pull': {
        const store = await createStore(context.media.store, storeContext);
        const result = await pullMedia(context, store, {
          force: parsed.flags.has('--force'),
          restore: parsed.flags.has('--restore'),
          dryRun: parsed.flags.has('--dry-run'),
        });
        const failed = result.conflicts.length > 0 || result.errors.length > 0;
        (failed ? io.err : io.out)(formatPull(result));
        return failed ? 1 : 0;
      }
      default:
        return 1;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MediaError || error instanceof LockError) {
      io.err(`${error.errors.join('\n')}\n`);
      return 1;
    }
    if (error instanceof MediaStoreError) {
      // The message about missing credentials is a whole paragraph of its own and says "coffer:" itself.
      io.err(error instanceof MissingCredentialsError ? `${error.message}\n` : `coffer: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
