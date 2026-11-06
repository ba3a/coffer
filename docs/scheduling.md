# Scheduled rebuilds: `build-info.json` and `coffer rebuild-needed`

A static site goes out of date without anyone touching it: a post dated for next Tuesday has to appear on Tuesday, and the documentation of a tool is pulled from another repository that changes on its own. Rebuilding on a timer would work, but it would deploy the same files over and over. coffer lets a scheduled job ask first.

Every build writes `build-info.json`, which the deployed site then serves. `coffer rebuild-needed` fetches that file from the live site, asks each git repository the site depends on for its current commit (`git ls-remote`), looks at the clock, and says `yes` or `no`. A scheduled job (for example a CI workflow that runs every 15 minutes) runs the command and starts a build and deployment only on `yes`. Nothing is stored between runs: the deployed site is the state.

## `build-info.json`

Each site's build writes `{out}/{siteId}/build-info.json`, at the root of the site (`https://example.org/build-info.json`). It is also listed, as `buildInfo`, in the [build manifest](build.md#the-build-manifest), and `coffer check` verifies that the file exists, has this shape and says what the manifest says.

```json
{
  "builtAt": "2026-06-01T08:09:10.123Z",
  "engineVersion": "0.1.0",
  "sources": {
    "lathe": {
      "url": "https://github.com/octo-org/lathe.git",
      "ref": "main",
      "sha": "0123456789abcdef0123456789abcdef01234567"
    }
  },
  "nextScheduledAt": "2026-06-04T20:00:00.000Z"
}
```

| Field             | Type                   | Meaning                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `builtAt`         | string, ISO 8601 (UTC) | When the build was made, by the system clock. It is not the "now" of `--now` or `COFFER_NOW`, which only decides which posts are published. Informational: `rebuild-needed` does not use it.                                                                         |
| `engineVersion`   | string                 | The version of coffer that built the site (the `version` in its `package.json`). Informational.                                                                                                                                                                       |
| `sources`         | object                 | The git [documentation sources](docs-sources.md) of the site's projects, by project slug (the project's folder name), sorted by slug. Each value has `url` (the address of the repository, with no credentials, query or fragment), `ref` (the branch or tag) and `sha` (the commit the build used: for an annotated tag, the commit the tag points at). A project whose documentation is a folder (`path`) is not listed, because a folder has no remote to compare. `{}` when the site has no git source. |
| `nextScheduledAt` | string or `null`      | The date of the earliest post of the site that is not a draft and is dated after the build's "now"; `null` when there is none. It is computed with the rule the build itself uses to publish posts (a post is published when it is not a draft and its date is not after "now"), over the posts of every blog of the site. A date without a time is read in the site's `timezone`, as in the pages. |

Readers must ignore fields they do not know. The file is pretty-printed JSON followed by a newline; the keys are always in the order above.

The file is for machines, but it is public: it holds nothing that is not already on the site or in a public repository. The repository addresses are written as they appear in `project.yaml` with credentials removed. Use no credentials in a public repository's address anyway (see [Where a project's documentation comes from](docs-sources.md)).

### Caching

The file only helps if a scheduled job sees the version that is deployed now. A host or a content network that caches it for hours would make the job rebuild too late, or again and again. Serve `build-info.json` with `Cache-Control: no-cache` (revalidate every time). On Cloudflare Pages that is a rule in the `_headers` file:

```
/build-info.json
  Cache-Control: no-cache
```

coffer does not write a `_headers` file itself; it belongs to the deployment configuration of the site. `coffer rebuild-needed` asks for a fresh copy (`Cache-Control: no-cache` in the request), which well-behaved caches respect.

### What else it is not

`build-info.json` is a name the build writes itself: it is in `RESERVED_OUTPUT_NAMES`, so `urls.projects` cannot start with it. It is not a page: it is not in the sitemap, the manifest's `pages`, the search index or any feed.

## `coffer rebuild-needed`

```
coffer rebuild-needed --url https://example.org/build-info.json [--config <path>] [--site <id>] [--json]
```

| Option            | Meaning                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--url <address>` | The address of the deployed `build-info.json`. Required. Only `http://` and `https://` addresses are fetched, and an address with a user name or password is refused.       |
| `--config <path>` | The [configuration](configuration.md); the sources to compare are read from the projects it names. Without it coffer looks for `coffer.yaml` in the working directory and its parents. |
| `--site <id>`     | The site the deployed file belongs to. Needed when the configuration has more than one site; with one site it may be left out.                                          |
| `--json`          | Print the answer as JSON.                                                                                                                                                |

The command needs no token and no installation of anything but coffer and git. A public repository is read anonymously. A repository that needs credentials works as it does for the build (credentials in the address in `project.yaml`, or ssh keys), and credentials never appear in the output.

### The answer

The answer is `yes` when any of these holds, and `no` otherwise:

| Reason code             | The answer is yes because                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployed-unavailable`  | The deployed file cannot be used: the server is unreachable or does not answer in time (15 seconds for the whole exchange), answers with anything but `200` after at most 3 redirects, sends more than 256 KiB, or sends something that is not valid JSON of the shape above. A missing file (404) is this case. |
| `source-sha-changed`    | A git source is configured and deployed, with the same repository and ref, but the branch or tag is at another commit now.                                         |
| `source-ref-changed`    | The ref of a source in the configuration is not the ref the deployed build used.                                                                                  |
| `source-url-changed`    | The repository of a source in the configuration is not the one the deployed build used.                                                                           |
| `source-added`          | A project has a git source in the configuration that the deployed build did not list.                                                                             |
| `source-removed`        | The deployed build listed a source that is no longer in the configuration.                                                                                        |
| `scheduled-time-passed` | `nextScheduledAt` of the deployed file is not after the current time: a post that was waiting for its date is due.                                                |

Sources are compared one project slug at a time, so one change is enough. The current time is the system clock.

Plain output is `yes` or `no` on the first line, then one line `- code: message` per reason:

```
yes
- source-sha-changed: lathe: main moved from 0123456789abcdef0123456789abcdef01234567 to 89abcdef0123456789abcdef0123456789abcdef
- scheduled-time-passed: a post scheduled for 2026-06-04T20:00:00.000Z is due (it is 2026-06-04T20:15:00.000Z)
```

With `--json` the output is one object:

```json
{
  "needed": true,
  "site": "main",
  "url": "https://example.org/build-info.json",
  "checkedAt": "2026-06-04T20:15:00.000Z",
  "reasons": [
    {
      "code": "source-sha-changed",
      "source": "lathe",
      "message": "lathe: main moved from 0123456789abcdef0123456789abcdef01234567 to 89abcdef0123456789abcdef0123456789abcdef"
    },
    {
      "code": "scheduled-time-passed",
      "message": "a post scheduled for 2026-06-04T20:00:00.000Z is due (it is 2026-06-04T20:15:00.000Z)"
    }
  ]
}
```

`needed` is a boolean, `reasons` is empty when it is `false`, and `source` is present only for the reasons about a source. The `url` is shown without a query or fragment.

### Exit codes

| Code | Meaning                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The command gave an answer, `yes` or `no`. The exit code does not say which: read the output (the first line, or `needed` in the JSON).                                                                      |
| 1    | The command could not give an answer: the configuration or a `project.yaml` is invalid, or a configured source could not be asked for its commit (the repository is unreachable, the branch or tag does not exist, git is missing, or git timed out). The message names the project and the repository. |
| 2    | A usage error: an unknown or missing option, an address that cannot be used (not `http`/`https`, or with credentials), an unknown site, or no `--site` when the configuration has several.                 |

A source that cannot be asked is deliberately not a `yes`: the build would fail on it too, so a scheduled job would only start a build that fails, over and over. The job should fail visibly instead, and the live site stays as it is. When the deployed file cannot be used the command does not ask the repositories at all, because the answer is `yes` whatever they say.

### In a scheduled job

```sh
needed=$(npx coffer rebuild-needed --url https://example.org/build-info.json --json | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).needed))')
if [ "$needed" = "true" ]; then
  # build and deploy
fi
```

A job that only reads public information needs no secrets, so run it without them and give the secrets only to the job that deploys.

## Limits

- Cron schedules on shared CI hosts run a few minutes late; with a 15-minute schedule a post appears within about 20 minutes of its date, and a change in a documentation repository within the same time.
- A post whose date is changed to the past, or a draft that is published, comes with a push, and a push deploys on its own.
- Only git sources are compared. A folder source (`path`) lives in the same repository as the site, so a push deploys it.
