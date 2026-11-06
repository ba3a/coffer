# Analytics

coffer counts nothing by itself. A site can, if its author wants rough page views and referrers, add one analytics snippet to its pages. It is off unless the site's `coffer.yaml` turns it on, and a site without it loads no third-party script at all.

```yaml
sites:
  - id: main
    # ...
    analytics:
      provider: cloudflare
      token: "0123456789abcdef0123456789abcdef"
```

| Key        | Description |
| ---------- | ----------- |
| `provider` | `none` (the default), `cloudflare` or `custom`. |
| `token`    | The token of the site in Cloudflare Web Analytics; required with `cloudflare`, an error with any other provider. Letters and digits only, 8 to 64 of them; write it in quotes so that YAML does not read a token made of digits as a number. |
| `html`     | A snippet of HTML; required with `custom`, an error with any other provider. |

A configuration that does not fit is refused with the key path: `cloudflare` without a `token`, `custom` without `html`, a `token` or `html` for a provider that does not use it, an unknown provider, or a token with a quote, a space or markup in it.

## The providers

**`cloudflare`** adds the Cloudflare Web Analytics beacon to every page:

```html
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "..."}'></script>
```

The token is not a secret. Cloudflare shows it in the page source of every site that uses the beacon, so it belongs in the configuration file in the repository. coffer still checks its shape and escapes it when it writes the page.

**`custom`** inserts the `html` text of the configuration at the same place, exactly as written and without escaping. It is trusted markup of the site author, not content: anything in it runs on every page of the site with the same rights as the site's own scripts. Put only a snippet you have read and chosen. Use it for another analytics service, for example a self-hosted one.

**`none`** (or no `analytics` key) adds nothing.

## Production builds only

The snippet is part of a normal build (`coffer build`, which is what the deployment runs). It is never part of a preview build: `coffer dev` and `coffer build --drafts` leave it out, so the author's own visits while writing and previewing are not counted. The pages of a preview are for the author alone and should not be sent to a third party.

## Where it is placed

`base.njk` has a block `analytics` at the very end of `<body>`, after the block `scripts`. It includes the partial `partials/analytics.njk`, which reads the global `analytics` that the build sets for production builds (`{ provider, token }` or `{ provider, html }`; it is empty for a preview build and for a site with provider `none`). Every page that extends `base.njk` has the snippet: the home page, posts, blog and tag indexes, the tag tree, series pages, the search pages, project pages, the pages of a project's guides, and the 404 page.

A theme changes it by replacing the partial `partials/analytics.njk` or by overriding the block, for example to leave it out of a page or to add a second snippet:

```njk
{% extends "coffer:page.njk" %}

{% block analytics %}{{ super() }}<script defer src="/assets/own-stats.js"></script>{% endblock %}
```

Two kinds of page are deliberately without it:

- the generic **reference page** that coffer produces from a JSON reference (`reference.njk`). It is a standalone page that does not extend `base.njk` and is not the site's look, and it carries no scripts of any kind. A reference in the `html` mode is the output of another tool and is copied as it is (see [Project documentation](project-docs.md#the-reference));
- redirect stubs and other pages that only forward the visitor.

A theme that wants the snippet on the reference page can include `partials/analytics.njk` in a replacement `reference.njk`.

## Privacy

What the Cloudflare beacon does is Cloudflare's to state, and can change; the properties below are what Cloudflare documents for Web Analytics and what coffer itself adds.

- coffer sets **no cookies** and stores nothing in the visitor's browser for analytics, and the beacon does not either, according to Cloudflare. That is why no consent banner is needed for it, and coffer never shows one.
- The visitor's IP address is not used to build a profile, and visitors are not tracked across sites; Cloudflare reports page views, visits, referrers, countries, browsers and page load timings, in aggregate.
- The snippet is a **third-party script**. Loading it means the visitor's browser makes a request to Cloudflare, and Cloudflare sees that request, as any server would. If that is not acceptable for a site, leave `analytics` out and use the alternative below. A `custom` snippet has whatever properties its service has.
- The default theme loads nothing from a third party otherwise: fonts, maps' scripts, the viewer and the search are served from the site itself (the map tiles are the one documented exception, see [Maps and GPX tracks](maps.md)).

## Numbers are approximate

Ad blockers and some browsers' tracking protection commonly block the beacon, in particular among technical readers, so the numbers undercount visits and the real audience is larger than they show. Read them as a rough trend, not as a count. Visitors with JavaScript turned off are not counted either.

## The script-free alternative

If the site is served through Cloudflare, the zone has its own **traffic analytics** (in the Cloudflare dashboard, under the analytics of the domain). They are counted on the server side from the requests Cloudflare answers, so they need no script on the page, are not blocked by ad blockers, and need nothing from coffer. They count requests, which include crawlers and feed readers, so they too are approximate, in the other direction. The two can be used together, and the server-side numbers are the ones to trust when they disagree. Other hosts have the same thing in their access logs or dashboards.

## Content Security Policy

A site that sends a strict `Content-Security-Policy` header has to allow the beacon, or the browser blocks it silently. With the `cloudflare` provider the policy needs

- `https://static.cloudflareinsights.com` in `script-src`, to load the beacon, and
- `https://cloudflareinsights.com` in `connect-src`, where the beacon sends what it measures.

The beacon needs no inline script and no `eval`. The `data-cf-beacon` attribute is data, not script. For a `custom` snippet, read what the snippet loads and allow just that. coffer writes no `Content-Security-Policy` header itself; set it in the hosting configuration (for Cloudflare Pages, a `_headers` file).

## `coffer check`

`coffer check` does not fetch external addresses, so the beacon address is not checked and does not fail the check. A page with the snippet passes the same checks as one without it.
