/**
 * Which devlog posts are about which project.
 *
 * A post is about a project when one of its tags equals the project's `tag` or
 * lies below it (the same subtree rule as a tag page and a tag feed), or when
 * its front matter lists the project's slug in `projects`. A post can be about
 * several projects. Two projects that share a `tag` both claim the posts that
 * carry it: each of those posts gets both project blocks.
 */

/** How many other recent posts a project block lists. */
export const PROJECT_BLOCK_POSTS = 3;

/**
 * Whether a post tag is the project's tag or lies below it.
 *
 * @param {string} tag A normalized tag path of a post.
 * @param {string} projectTag The normalized `tag` of a project.
 * @returns {boolean}
 */
export function tagInProjectTag(tag, projectTag) {
  return tag === projectTag || tag.startsWith(`${projectTag}/`);
}

/**
 * The projects a post is about, found by its tags and by its `projects` list.
 *
 * @param {{ tags: readonly string[], projects: readonly string[] }} post
 * @param {readonly { slug: string, tag: string | null }[]} projects The registered projects, in the order their blocks should appear.
 * @returns {{ slugs: string[], unknown: string[] }} The slugs of the projects the post is about, in the order of `projects`, and the slugs in `post.projects` that no project has.
 */
export function projectsOfPost(post, projects) {
  const known = new Set(projects.map((project) => project.slug));
  return {
    slugs: projects
      .filter(
        (project) =>
          post.projects.includes(project.slug) ||
          (project.tag !== null && post.tags.some((tag) => tagInProjectTag(tag, /** @type {string} */ (project.tag)))),
      )
      .map((project) => project.slug),
    unknown: post.projects.filter((slug) => !known.has(slug)),
  };
}

/**
 * The message for a slug in `projects:` that no project has.
 *
 * @param {string} slug
 * @param {Iterable<string>} registered The slugs of the registered projects.
 * @returns {string}
 */
export function unknownProjectMessage(slug, registered) {
  const known = [...registered].sort();
  const hint = known.length === 0 ? 'the site has no projects' : `registered: ${known.join(', ')}`;
  return `projects: unknown project '${slug}' (${hint})`;
}

/**
 * A post as the lists about a project see it.
 *
 * @typedef {object} ProjectPostRef
 * @property {string} url Site-relative URL of the post.
 * @property {string} title
 * @property {Date} date
 * @property {string | null} summary
 * @property {number} readingMinutes
 */

/**
 * Orders posts newest first; posts of the same moment by address.
 *
 * @template {{ date: Date, url: string }} P
 * @param {readonly P[]} posts
 * @returns {P[]}
 */
export function newestFirst(posts) {
  return [...posts].sort(
    (a, b) => b.date.getTime() - a.date.getTime() || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
}
