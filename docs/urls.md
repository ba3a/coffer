# URLs, redirects and hosting

Every page has one address, and every other spelling of it redirects there. Visitors, search engines and feed readers therefore see a single URL per page.

## The canonical form

- **A trailing slash.** Pages are written as `{path}/index.html`, so their address is `/journal/first-dovetail/`. The blog index is `/journal/`, the home page `/`.
- **A post address depends on the blog prefix and the slug only.** Not the date, not the tags. Retagging a post or moving its date never breaks a link. See [Posts](posts.md) for how the slug is chosen.
- **The same address without the slash redirects.** `/journal/first-dovetail` answers `308` and sends the visitor to `/journal/first-dovetail/`. So does `/journal/first-dovetail/index.html`.
- **Unknown addresses** answer `404` with the site's own `404.html`, in the site's language and style (see [The home page, the 404 page and the footer](home.md)).
- **The search page** of a blog is `/journal/search/` (`/search/` for a blog at the root), so a post cannot have the slug `search`. The search index is written to `/pagefind/` at the root of the site. See [Search](search.md).
- **The share summary** of a post, `share.txt`, is written next to the post's page (`/journal/first-dovetail/share.txt`) on a blog with `shareSummary: true`; a file of that name in a post's folder fails the build. See [Share summary](sharing.md).
- Files with an extension, such as `/assets/coffer.css` or a feed, are not redirected; they have no slash form.

The hosts below do the slash redirects by themselves when they find `a/index.html`. coffer only has to write the files.

## Aliases: old slugs

When a post is renamed, keep its old address alive by listing the old slug in `aliases` in the front matter:

```yaml
---
title: My first hand-cut dovetail
date: 2025-03-14
aliases: [dovetail-diary]
---
```

For the post at `/journal/first-dovetail/` this makes `/journal/dovetail-diary/` (and `/journal/dovetail-diary`) redirect permanently, with status `301`, to the new address. An alias is a slug (letters, digits, `.`, `_`, `-`) in the same blog as the post, so it lives under the same prefix. In a blog with an empty prefix the old address is `/{old}/`.

The build writes two things for each alias:

1. **Rules in `_redirects`**, at the root of the site's output (`{out}/{siteId}/_redirects`), one for each spelling:

   ```
   /journal/dovetail-diary/ /journal/first-dovetail/ 301
   /journal/dovetail-diary /journal/first-dovetail/ 301
   ```

   The file is only written when there is at least one alias.
2. **A fallback page** at `{old}/index.html` for hosts that ignore `_redirects`. It contains `<meta http-equiv="refresh" content="0; url=...">`, `<link rel="canonical">` with the absolute address of the live page, and `noindex`, so a browser jumps to the new page at once and search engines follow the canonical link.

Only published posts count. The alias of a draft or of a post dated in the future is ignored until the post is published. The redirects are also listed under `redirects` in the [build manifest](build.md).

### Collisions

An alias must not be the address of anything the site builds. The build fails, naming the Markdown file, when an alias:

- equals the slug of another published post in the same blog (the old address would hide a live page);
- is claimed by two published posts;
- is the address of another generated page.

An alias that equals the slug of a draft is fine, because the draft is not live; publishing the draft turns it into an error, which is the point of the check.

## Checking the rules locally: `coffer serve`

```
coffer serve [dir] [--port <number>] [--host <address>]
```

`coffer serve` serves one site directory, that is `{out}/{siteId}` after a build, with the behaviour of Cloudflare Pages. It has no dependencies and is meant for looking at the result and for tests, not for production. Without `dir` it serves the working directory; the port defaults to 8080 and the host to `localhost`. Stop it with Ctrl+C.

| Request                                 | Answer                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| `/a/` when `a/index.html` exists        | `200` with the page                                     |
| `/a` when `a/index.html` exists         | `308`, `Location: /a/` (the query string is kept)       |
| `/a/index.html`                         | `308`, `Location: /a/`                                  |
| a path that has a rule in `_redirects`  | the rule's status (`301`, `302`, `303`, `307`, `308`) and destination |
| an existing file                        | `200` with its content type                             |
| anything else                           | `404` with the content of `404.html`                    |

`_redirects` rules are applied first, as on Cloudflare Pages. The server understands `from to [status]` lines (status defaults to `301`), `#` comments, a trailing `*` in `from` and `:splat` in `to`. Rewrites (status `200`), placeholders such as `:slug`, and the `_headers` file are not emulated. Only `GET` and `HEAD` are answered. The files and the rules are read on every request, so rebuilding the directory shows up without a restart.

From code, `startServer({ dir, port })` resolves to an object with the `url` and a `close()` function; port `0` picks a free one. coffer's own tests use it to request URLs with and without the slash, an alias and an unknown path.

## Hosting notes

Deploy the contents of `{out}/{siteId}`, leaving out the files listed in `DEPLOY_EXCLUDES` (see [Building a site](build.md)). `_redirects` must be part of what you upload.

### Cloudflare Pages

- Upload the site directory as the build output; no build command is needed when the output is built beforehand, for example by `wrangler pages deploy {out}/{siteId}`.
- Pages serves `a/index.html` at `/a/` and redirects `/a` and `/a/index.html` to `/a/` with `308` on its own. This is the behaviour `coffer serve` emulates.
- `_redirects` at the root of the output is read by Pages. The rules from aliases are plain static redirects; Pages allows 2,000 of them per project.
- `404.html` in the root is used for every unknown address, with status `404`.
- Pages also removes the `.html` extension from addresses (`/about.html` becomes `/about`). coffer never links to such addresses, and `coffer serve` does not emulate this.

### Netlify

- Publish the site directory. `_redirects` in the root is read in the same format.
- Netlify serves `a/index.html` at `/a/` and redirects `/a` to `/a/` when the "pretty URLs" post-processing is on, which is its default for new sites. Without it, a request for `/a` may answer `200` with the page, so turn pretty URLs on or add a rule in `netlify.toml`.
- A root `404.html` is used for unknown addresses.
- Netlify applies a `_redirects` rule only when no file exists at the requested path, unless the rule is forced with `!` after the status. An alias address has the fallback page as its file, so on Netlify visitors get that page (status `200`, immediate meta refresh, canonical link) rather than a `301`. coffer does not write `301!` because Cloudflare Pages does not accept that syntax. If you need a real `301` on Netlify, copy the rules into `netlify.toml` with `force = true`.

### Other hosts

Any static host that serves `a/index.html` for `/a/` works. Without `_redirects` support the fallback pages still take visitors to the new address, though with status `200` instead of `301`; the `canonical` link tells search engines which address is the real one.
