import { readFileSync } from 'node:fs';

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
