# Contributing to coffer

Thank you for wanting to help. This page says how to set up, how to test a change, what the code should look like and how to propose something new.

## Setup

You need Node.js 24 or newer and git.

```
git clone <the address of this repository>
cd coffer
npm install
npm run example
```

`npm run example` builds the example site into `example/dist/workshop`. If it succeeds, the setup works. Look at the result with `npx coffer serve example/dist/workshop`, or edit the example and watch the pages reload with `npx coffer dev --config example/coffer.yaml`. See the [README](README.md) for more.

## Tests

```
npm test
```

runs every test in `test/` with the test runner built into Node, and then the type check. Both must pass before a change is merged. While you work, run one file or the type check on its own:

```
node --test test/tags.test.js
npm run typecheck
```

Tests are written with `node:test` and `node:assert/strict`. A few guidelines:

- Write the test first, or together with the change. A bug fix starts with a test that fails.
- Test through the example site where you can: build it, or a small site made in a temporary directory, and look at the files that come out. The example is the engine's own test target, so a feature that the example cannot show is probably not finished.
- Tests must not need the network, an account or a secret. Replace git, HTTP and the clock with the parameters the code offers for it.
- Tests leave nothing behind. Use a temporary directory and remove it.

The test suite takes several minutes, because it builds sites and processes images.

### Continuous integration

`.github/workflows/ci.yml` runs `npm ci` and `npm test` on Linux and on Windows for every push and pull request, with the Node.js version named in `.nvmrc`. Both systems must be green before a change is merged.

The workflow expects `package-lock.json` to be committed in this repository, because `npm ci` and the dependency cache of the workflow read it. When you change a dependency in `package.json`, run `npm install` and commit the updated lock file with it.

## Style

- Plain JavaScript in ES modules, with types written as JSDoc comments. `npm run typecheck` checks them strictly, so a new function needs accurate `@param` and `@returns` tags. There is no build step: the code you write is the code that runs.
- Two spaces for indentation, single quotes, semicolons, LF line endings and a final newline.
- Prefer small modules that do one thing. Errors that a site author can fix are reported with a message that names the file and the problem, and they fail the build; they are not logged and skipped.
- Comments say why, not what. Documentation says what a feature does, and belongs in `docs/`.
- Pages must stay readable without JavaScript. A feature that needs scripts must say so in its documentation and degrade to something useful without them.
- Nothing is loaded from another host: no CDN, no web font service, no tracking.
- Code and documentation are written in plain English, for readers who may not be native speakers.

## The neutrality rule

coffer is a general tool. Nothing in the code, the example, the tests or the documentation may name its author, their projects or their sites, apart from the license, the notice and the credits section of the README. The example site is made up, and so are all the names in it.

`test/neutrality.test.js` enforces this by scanning every file for a list of words kept at the top of that file. If it fails on your change, rephrase and use a made-up name. Write examples with names such as `lathe`, `example.org` and `octo-org`, and use a reserved domain (`.example`) for addresses.

## Proposing a feature

1. Look through the [documentation index](docs/README.md) and the open issues, in case it exists or is already proposed.
2. Open an issue with the "Feature request" template. Describe the problem first, then what you would like. Small, general solutions are preferred to ones that serve a single site.
3. Wait for a reply before you write a large change. A short discussion saves time for everyone, and the answer may be that the feature belongs in a theme or in your own site's configuration and not in the engine.
4. A feature is finished when it has tests, a page in `docs/` (linked from `docs/README.md`), an entry under "Unreleased" in the [changelog](CHANGELOG.md), and, if it is visible, something in the example site.

Bug reports use the "Bug report" template. A failing test that shows the bug is the best report.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): a type, a colon and a short summary in the imperative mood, for example `feat: Add a series page` or `fix: Keep the query string when redirecting`. Use `feat`, `fix`, `docs`, `test`, `refactor`, `chore` and `build`. Put the reason for the change in the body of the message.

Keep a pull request to one change, make sure `npm test` passes, and say in the description what changed and why. A change that breaks existing sites says so in the changelog.

## Versions

coffer uses [semantic versioning](https://semver.org/), and the changelog records every release. Maintainers cut releases: they move the "Unreleased" entries under the new version, set the version in `package.json` and tag the commit. You do not need to change the version number in a pull request.

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), like the rest of coffer.
