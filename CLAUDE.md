# Guidance for developing coffer

Run the tests with `npm test`. The rules for documentation and the changelog are in CONTRIBUTING.md.

## Website landing page (ba3a.dev)

`site/landing.md` is this project's landing page on ba3a.dev. The site fetches it from `main`
and republishes within about 15 minutes of a push; nothing else has to change. It goes stale
fast, so keep it true.

- When a change alters what a user sees or types (commands, flags, output, install steps,
  supported platforms, features, limits, license, version or size claims), update the matching
  section of `site/landing.md` in the same commit.
- Every command, number and output sample on the page must match the code. Re-run a sample
  when you touch it.
- Keep the section markers (`<div class="section-marker" id="name"></div>`) and their names
  (hero, problem, audience, how-it-works, timeline, spec-example, features, compare, dogfood,
  quick-start, faq, final-cta). The theme lays the sections out; do not add layout markup.
- Links and images must resolve: a broken one fails the ba3a.dev build.
- Leave `site/brand/` and `site/card.png` alone unless asked.
