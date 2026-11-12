import { checkBuildInfoUrl, compareBuildInfo, fetchBuildInfo } from './build-info.js';
import { loadProjects } from './content/projects.js';
import { displayAddress, readRemoteCommits, redactUrl } from './docs/sources.js';

/**
 * `coffer rebuild-needed`: decides whether the deployed site is out of date.
 *
 * It fetches the `build-info.json` of the deployed site, asks each configured
 * git documentation source for the commit it is at now (`git ls-remote`, no
 * token for a public repository) and compares them with what the deployed
 * build used, source by source; it also checks whether a post that was waiting
 * for its date is due. See `docs/scheduling.md`.
 */

/**
 * Raised for a mistake in how the command was used (exit code 2).
 */
export class RebuildUsageError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'RebuildUsageError';
  }
}

/**
 * The answer.
 *
 * @typedef {object} RebuildAnswer
 * @property {boolean} needed
 * @property {string} site Id of the site that was compared.
 * @property {string} url The address of the deployed file, without a query.
 * @property {string} checkedAt ISO 8601 moment of the check.
 * @property {import('./build-info.js').Reason[]} reasons Why a rebuild is needed; empty when it is not.
 */

/**
 * @typedef {object} RebuildOptions
 * @property {import('./config.js').CofferConfig} config
 * @property {string} url Address of the deployed `build-info.json`.
 * @property {string} [site] Id of the site; may be left out when the configuration has one site.
 * @property {Date} [now] The moment to judge scheduled posts against (default the clock).
 * @property {import('./build-info.js').HttpOptions} [http] How the deployed file is fetched (limits; tests).
 * @property {Pick<import('./docs/sources.js').FetchOptions, 'timeoutMs' | 'exec' | 'env'>} [git] How git is run (tests).
 */

/**
 * @param {import('./config.js').CofferConfig} config
 * @param {string | undefined} id
 * @returns {import('./config.js').SiteConfig}
 */
function pickSite(config, id) {
  const known = config.sites.map((site) => site.id).join(', ');
  if (id !== undefined) {
    const site = config.sites.find((candidate) => candidate.id === id);
    if (site === undefined) throw new RebuildUsageError(`no site "${id}" (known: ${known})`);
    return site;
  }
  if (config.sites.length !== 1) {
    throw new RebuildUsageError(`the configuration has ${config.sites.length} sites; choose one with --site <id> (known: ${known})`);
  }
  return config.sites[0];
}

/**
 * The git documentation sources the site is configured with.
 *
 * A project counts when it has a git `docs.source`, whatever else it has: a project with a
 * landing file and no guides is compared too, because a push to its repository changes the page.
 *
 * @param {import('./config.js').SiteConfig} site
 * @returns {{ slug: string, source: { git: string, ref: string }, landing: string | null }[]}
 */
function configuredSources(site) {
  if (!site.projects) return [];
  /** @type {{ slug: string, source: { git: string, ref: string }, landing: string | null }[]} */
  const sources = [];
  for (const project of loadProjects(site.projects.dir)) {
    const docs = /** @type {import('./docs/sources.js').DocsConfig | null | undefined} */ (project.fields.docs);
    if (docs && 'git' in docs.source) sources.push({ slug: project.slug, source: docs.source, landing: project.landing?.file ?? null });
  }
  return sources;
}

/**
 * Decides whether a site has to be rebuilt.
 *
 * A deployed file that is missing, cannot be read or has the wrong shape means
 * yes, with the reason; so does any difference per project slug (a source that
 * was added or removed, a changed repository or ref, or a branch or tag that
 * moved) and a scheduled post whose time has come. Failing to read the commit
 * of a configured source is not an answer: it throws (a {@link DocsSourceError}).
 *
 * @param {RebuildOptions} options
 * @returns {Promise<RebuildAnswer>}
 * @throws {RebuildUsageError} For a site that cannot be chosen or an address that cannot be used.
 * @throws {import('./docs/sources.js').DocsSourceError} When a configured source cannot be asked for its commit.
 * @throws {import('./content/projects.js').ProjectError} When the projects cannot be read.
 */
export async function rebuildNeeded({ config, url, site: siteId, now = new Date(), http, git }) {
  const site = pickSite(config, siteId);
  const address = checkBuildInfoUrl(url);
  if ('problem' in address) throw new RebuildUsageError(`--url ${address.problem}`);
  const shownUrl = redactUrl(address.url.href);
  /** @param {import('./build-info.js').Reason[]} reasons */
  const answer = (reasons) => ({ needed: reasons.length > 0, site: site.id, url: shownUrl, checkedAt: now.toISOString(), reasons });

  const fetched = await fetchBuildInfo(address.url.href, http);
  if (!fetched.ok) {
    return answer([{ code: 'deployed-unavailable', message: `the deployed ${shownUrl} cannot be used: ${fetched.reason}` }]);
  }

  const configured = configuredSources(site);
  const commits = await readRemoteCommits(configured, git);
  /** @type {Map<string, import('./build-info.js').BuildInfoSource>} */
  const current = new Map();
  for (const { slug, source, landing } of configured) {
    const sha = /** @type {string} */ (commits.get(slug));
    current.set(slug, { url: displayAddress(source.git), ref: source.ref, sha, ...(landing === null ? {} : { landing: { file: landing, sha } }) });
  }
  return answer(compareBuildInfo(fetched.info, current, now));
}

/**
 * The plain-text form of an answer: `yes` or `no` on the first line, then one
 * line per reason.
 *
 * @param {RebuildAnswer} answer
 * @returns {string}
 */
export function formatRebuildAnswer(answer) {
  return `${[answer.needed ? 'yes' : 'no', ...answer.reasons.map((reason) => `- ${reason.code}: ${reason.message}`)].join('\n')}\n`;
}
