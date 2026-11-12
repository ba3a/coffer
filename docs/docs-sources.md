# Where a project's documentation comes from

A tool project can publish documentation that lives in its own repository. The `docs` block of its `project.yaml` says where that repository is, which folders hold guides, and in what order they appear. This page covers describing the source and fetching it; how the guides are rendered is in [Project documentation](project-docs.md). The generated reference is described in [Project documentation](project-docs.md#the-reference).

```yaml
# content/projects/kerfcalc/project.yaml
docs:
  source:
    git: https://github.com/octo-org/widget.git
    ref: main
  guides:
    - dir: docs
      order: [getting-started.md, usage.md]
      exclude: ["drafts/**"]
```

Everything about where the guides come from, their order and what is left out is configuration; no code changes are needed to change it.

## The `docs` block

| Key         | Required | Meaning |
| ----------- | -------- | ------- |
| `source`    | yes      | Where the files are: a git repository (`git` and `ref`) or a folder (`path`). Exactly one of the two. |
| `github`    | no       | `owner/repo` of the GitHub repository that links to files point at. Taken from a `github.com` address (`https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, `ssh://git@github.com/o/r`) when not given; otherwise null. |
| `guides`    | no       | A list of guides. Without any, no guide is published and the project has no documentation pages and no documentation link. |
| `reference` | no       | The command that generates a reference, and what to do with its output: `command`, `format`, `output`, `title`, optional `undocumented`, `index` and `autoLink` (see [The reference](project-docs.md#the-reference)). |

Unknown keys are refused. Every problem in the block is reported at once, with the path of `project.yaml` and the field, like any other field (`.../project.yaml: docs: source.git: the scheme "ext" is not allowed (...)`).

### `source`

- **`git`** is the address of a repository: `https://host/owner/repo.git`, `ssh://[user@]host[:port]/owner/repo.git`, `user@host:owner/repo.git`, or `file:///absolute/path` (meant for tests and local work). The scheme must be one of those. Addresses that start with `-`, contain white space, control characters, quotes, backslashes or any of `< > | $ ; { } ^`, contain `..` in the path, have a host or user starting with `-`, or use another transport (`ext::`, `fd::`, `git://`, plain `http://`, a local path) are refused. A **query (`?`) or fragment (`#`)** is refused too, because a token put there (`...git?access_token=...`) would be copied into messages and the manifest; and in an `ssh` address (also the `user@host:path` form) the user and the host must not contain percent-escapes (`%2D` could hide a leading `-`), and the port must be a number from 1 to 65535. `ssh://[::1]/owner/repo.git` (an IPv6 host in brackets) is accepted. An address may carry credentials in its user information (`https://token@host/...`); they are used, but never printed or written to the manifest (messages, `coffer docs fetch` output, `.coffer/report.json` and `.coffer-manifest.json` show the address without them, and an address that is refused is not repeated in the message, because a password cannot be told from the rest of a text that is not an address; this includes a password in the `user:password@host:path` form). `project.yaml` is the wrong place for credentials if the file is public. The cache is a different matter: the clone in `.cache/repos/{slug}` keeps the address, credentials included, in its `.git/config`, so `.cache/` must never be published or shared. `.cache/` is in this repository's `.gitignore` by default; keep it there and out of any deploy.
- **`ref`** (required with `git`) is a branch or tag name: letters, digits, `.`, `_`, `-` and `/`, at most 200 characters, not starting with `-`, not containing `..` or `//`, not ending in `.lock`.
- **`path`** is a folder, read in place. A relative path is relative to the **project's folder** (`content/projects/{slug}/`), so a folder next to the content directory is written `../../../sample-tool`. The folder may be anywhere on the disk, because it is read, never written. It has to exist and be a folder, otherwise the project's `project.yaml` is reported.

### `guides`

Each item is a mapping:

| Key       | Meaning |
| --------- | ------- |
| `dir`     | Required. The folder of the guide inside the source, with `/`; `.` for its root. |
| `order`   | File names, relative to `dir`, that come first, in this order. Default none. |
| `include` | Glob patterns, relative to `dir`, of the files to publish. Default `["**/*.md"]`. |
| `exclude` | Glob patterns, relative to `dir`, that take files out again. Default none. |

Paths are relative to the repository and stay inside it: no `..`, no leading `/`, no drive letter, no backslash. There are at most 20 guides, 200 names in `order`, 50 patterns in each of `include` and `exclude`, and no path or pattern is longer than 200 characters. A folder cannot be listed twice. The files are read with `resolveInside`, which also refuses a symbolic link that leads out of the repository.

A guide folder that is missing from the fetched source fails the build (see below).

**Patterns.** `include` and `exclude` are matched by a small matcher of coffer's own that takes time in proportion to the pattern times the path (it builds no regular expression and never backtracks, so a pattern from a configuration file cannot be made expensive). A pattern is checked when the configuration is read; one that uses what the matcher does not support is refused with a message that names it:

- `/` separates folders; a pattern is matched against the whole path relative to `dir`;
- `*` is any run of characters inside one name, `?` is one character, `[abc]`, `[a-z]` and `[!abc]` are one character of a set;
- `**` as a whole segment is any number of folders, also none: `**/*.md` matches `a.md` and `x/y/a.md`, `drafts/**` everything below `drafts`;
- matching is case-sensitive, and a name that starts with a dot (`.github`, `.draft.md`) is matched only by a pattern segment that starts with a literal dot;
- not supported: `{a,b}` alternatives (list one pattern for each), a leading `!` (use `exclude`) and `\` escapes.

Only Markdown files (`.md` and `.markdown`) become pages, whatever the patterns select.

## Fetching: `coffer docs fetch`

```
coffer docs fetch --config example/coffer.yaml
coffer docs fetch --project kerfcalc
```

It fetches the docs source of every tool project that has one (or of the project named by `--project`), and prints one line per project, `slug: <commit> (<address or path>)`:

```
widget: 4f1c0e... (https://github.com/octo-org/widget.git, ref main)
kerfcalc: 9a2b77... (../../../sample-tool)
```

Failures of all projects are collected and printed together, one per project, and the exit code is 1. `coffer build` runs the same fetch before it renders anything, so a build never starts from stale or empty documentation. The build is not made network dependent unless a project asks for a git source: the example site uses a `path` source.

### Git sources and the cache

A git source is shallow-cloned (`--depth 1 --single-branch --no-tags`) into `.cache/repos/{slug}`, beside the configuration file (`cacheDir` moves the whole cache). If the cache already holds a clone of the **same address** (`remote.origin.url` is compared), it is updated instead: the ref is fetched (depth 1), the work tree is hard-reset to it and untracked files are removed. A clone of another address, a folder that is not a clone, or a link in its place is deleted and cloned again. The checkout is always addressed with an explicit `--git-dir` and `--work-tree`, so git can never operate on a repository that happens to contain the cache folder.

**Stale content is never reused, and a damaged cache heals itself.** The cache is a speed-up, not a store. When an update step fails (the server is unreachable, the ref was removed, git was killed earlier and left a `shallow.lock` or `index.lock`, the `.git` folder is truncated), the cached checkout is **deleted** and the repository is cloned again, once. If the fresh clone fails too, the fetch fails with that failure and nothing is left in the cache; the checkout from an earlier build is never used as a fallback. Two failures are not retried, because a second attempt cannot help: git is not installed, and git ran out of time (the copy is still deleted, since a killed update may have left it half written; a hung server therefore costs one timeout, not two). The cache may hold credentials in `remote.origin.url` if the address has them, so it lives under `.cache/`, which is ignored by git by default and must not be published.

**One build at a time per cache folder.** Two `coffer build` or `coffer docs fetch` processes must not use the same cache folder (the same site folder, or the same `cacheDir`) at the same moment. One of them can delete or lock the checkout while the other clones into it or reads it, so either can fail (usually with a lock error or a missing file) or fetch the same repository twice; they do not corrupt each other silently, and the next build on its own recovers by cloning again as described above. A CI system should serialize the builds of one workspace, or give each build its own `cacheDir`. Two sites of one configuration that have a project folder of the same name share one cache folder (`.cache/repos/{slug}`); `coffer docs fetch` refuses to run (exit 1, naming the project folder, both sites and both addresses without credentials) only when both configure a **git** source and the address (`git`) or the `ref` differ. The same git source with different `guides` is not a conflict: it is fetched once and the guide folders of every site are checked against that checkout. A `path` source never uses the cache, so it never conflicts; the guides, `github` and `reference` are not part of the source. The build fetches the sources of the projects one after the other.

The commit (`git rev-parse HEAD`, 40 or 64 hex digits) is recorded. For a tag, it is the commit the tag points at.

### Git safety

The address comes from a configuration file and the content from a repository that may not be yours, so:

- git is run with `child_process.spawn` and an argument list, never through a shell; the address is passed after `--`, the ref as `--branch=<ref>` or after `--`. The refs the schema accepts contain only letters, digits, `.`, `_`, `-` and `/`, so a ref cannot carry a token or a URL into a message;
- `git` is found once, in the absolute folders of the `PATH`, and started by its absolute path; the current folder and relative `PATH` entries are skipped (Windows would otherwise run a `git.exe` that lies in the folder git is started in). On Windows only `git.exe` and `git.com` in absolute `PATH` entries are used: a `git.cmd` or `git.bat` shim alone cannot be started without a shell, so it gives the plain error `git was not found; install git and make sure it is on the PATH`. Every git call, also the lookup of the commit of a `path` source (which names the source with `-C <folder>`), and `taskkill`, runs in a folder of the cache or of the system, never in the folder of a source;
- every `GIT_*` variable of the surrounding environment is dropped (so a `GIT_DIR` or `GIT_CONFIG_*` cannot redirect it), except `GIT_SSH_VARIANT`, and these are set: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` empty (no helper is asked for a password), `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` an empty file, `GIT_ALLOW_PROTOCOL` the one transport the address uses (`https`, `ssh` or `file`), and `GIT_SSH_COMMAND`. Without an ssh program of your own that is `ssh -o BatchMode=yes` (ssh never asks anything). Your own `GIT_SSH_COMMAND` (or `GIT_SSH`) is kept: when it is OpenSSH (`ssh` or `ssh.exe`) `-o BatchMode=yes` is appended; any other client (`plink`, `TortoiseGitPlink`, a wrapper script) takes no `-o`, so it is run exactly as you set it up and has to be non-interactive on its own. The rest of the process's environment (`PATH`, `HOME`, proxy and certificate variables, and whatever secrets it holds) is passed on to git and ssh;
- every call carries `-c core.hooksPath=<an empty folder>`, `core.fsmonitor=false`, `credential.helper=` (none), `submodule.recurse=false` and `transfer.fsckObjects=true`; submodules are not fetched;
- each call has a timeout (default 120 s) after which git and everything it started is killed (`taskkill /T` on Windows, the process group elsewhere), and only the last 1 MiB of its output is kept. The call is reported as failed about 0.3 s after the killed process has exited (a helper it started may keep its output open a moment longer), and in any case at most 3 s after the kill; on Windows a 1.5 s limit takes about 1.8 s;
- messages and the manifest carry the address without credentials (`https://user:pw@host/x` becomes `https://host/x`; an ssh user name is kept, a password is not), and git's own output is scrubbed the same way. Any query or fragment of an address in a message is dropped as well (the schema refuses them, so this is a second line of defence for what git prints);
- a failure of the file system (the cache folder cannot be created, a copy cannot be deleted; deleting is retried for a moment, because Windows can hold the files of a process that was just stopped) is reported like any other failure, as `project "slug": cannot fetch the docs source <address>: ...`, and together with the failures of the other projects.

Because the global git configuration is ignored, private repositories over https need credentials in the address, or use ssh with your agent or keys.

### Folder sources

A `path` source is read where it is. If the folder is inside a git repository, the commit of that repository (`HEAD`) is recorded together with whether the folder has uncommitted changes (`dirty`); outside a repository both are null. This needs git only for that lookup; a missing git or a repository git refuses to read (for example because of ownership) gives null rather than a failure.

### Failures

Each of these fails the build and `coffer docs fetch` with a message that names the project and the address (or folder):

- git is not installed;
- the repository is unreachable, refuses access, or does not finish within the timeout;
- the ref does not exist ("the branch or tag does not exist in the repository");
- a `path` folder is gone;
- a guide folder is missing from the source, is not a folder, or leads out of it;
- the cache folder cannot be created or a cached copy cannot be removed.

There is no fallback to empty documentation.

## In the manifest

Each project of the manifest has `docs`: null without a `docs` block, otherwise

```json
{
  "source": { "type": "git", "git": "https://host/o/r.git", "ref": "main", "sha": "4f1c..." },
  "github": "o/r",
  "guides": [{ "dir": "docs", "order": ["a.md"], "include": ["**/*.md"], "exclude": [] }]
}
```

A project with a `landing` file (see [The landing file as the page](projects.md#the-landing-file-as-the-page)) also has `"landing": { "file": "site/landing.md", "sha": "4f1c..." }`: the path of the file in the source and the commit it was read at (the `sha` of `source`; null for a path source outside a git repository). `landing` is null for a project without one. For a git source the same pair is written to `build-info.json` (see [Scheduled rebuilds](scheduling.md)), so `coffer rebuild-needed` notices a push to the project repository even when the project has no guides.

Beside these, `pages` lists the documentation pages built from the guides (see [Project documentation](project-docs.md)): `{ "url", "file", "source", "title" }`, where `source` is the path of the guide file in the source and null for the docs index the build writes when no file is one. `pages` is empty when the project has no guide.

A path source is `{ "type": "path", "path": "sample-tool", "sha": "9a2b..." | null, "dirty": false | null }`, where `path` is relative to the configuration file when the folder is inside its directory, and as written in `project.yaml` otherwise.

## The link to the documentation

A tool's page and its project block link to `/{projects}/{slug}/{docs}/` **if and only if the build rendered documentation pages for the project**, so that the link never leads to a page that does not exist and `coffer check` stays green. A `docs` block without `guides` and without `reference` fetches the source and records it in the manifest but publishes no page and writes no link. A block with only a `reference` publishes the reference and a docs index that lists it.

## What comes next

- The guides are rendered from the fetched source; see [Project documentation](project-docs.md).
- The command of `reference` runs in the fetched checkout, after the fetch; see [The reference](project-docs.md#the-reference).

The fetch result (`FetchedDocs`) carries what they need: `root`, the folder the guides are read from, the `source` with the `sha`, the `github` repository and the normalized `guides`.

## Trust

The files of the source are content of a repository that may not be yours, and they are treated that way: every file is reached through `resolveInside` (a symbolic link that leads out of the repository is refused), a page can be at most 1 MiB and a project can publish at most 500 pages, nothing outside the repository is read, and every address a page contains is checked (see [link rewriting](project-docs.md#link-rewriting)). **Raw HTML in a guide is passed through unchanged, as it is in your own posts and project pages** (embeds, `<details>`, `<div>`, and also `<script>` or event attributes), because the author of a project is the author of its site. Only addresses are made safe: an `href`, `src`, `srcset` or `poster` that has a scheme other than `http:`, `https:` or `mailto:` (`javascript:`, `data:`, `vbscript:`, `file:`) fails the build and is replaced by `#` in the page. If you publish the documentation of a repository you do not control, review its files like code.
