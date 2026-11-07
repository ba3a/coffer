# Media originals

Photos and videos are large, and every version of a file stays in git history for ever. A repository that holds a few hundred full-size photos is slow to clone within a year. With a `media` block in `coffer.yaml`, the original files stay out of git: a small text file, the **lock file**, goes into git and says which originals belong to the repository, and a **media store** keeps their content. Moving the originals between the store and a working copy is one command in each direction.

Without a `media` block nothing changes and nothing here applies. The example site keeps its images in git and is built exactly as before.

- [How it works](#how-it-works)
- [Setting it up](#setting-it-up)
- [Day to day](#day-to-day)
- [The commands](#the-commands)
- [The lock file](#the-lock-file)
- [What `pull` changes and what it never does](#what-pull-changes-and-what-it-never-does)
- [What goes into `.gitignore`](#what-goes-into-gitignore)
- [Stores](#stores)
- [Cloudflare R2](#cloudflare-r2)
- [Credentials and `.env.local`](#credentials-and-envlocal)
- [Git hooks](#git-hooks)
- [What is checked](#what-is-checked)

## How it works

- An **original** is a file that matches `media.include` (by default the common image and video formats below each site's `contentDir`).
- The **lock file** (`media.lock.json`, committed) has one line per original: its path, the SHA-256 of its content and its size.
- The **store** keeps each original under the name `originals/{sha256}`. Objects are named by their content, so two copies of one photo are one object, an object is never overwritten with something else, and a replaced photo adds a new object next to the old one.
- Every working copy has a private folder `.coffer/` (never committed) with a cache of file hashes, so that a file that did not change is not read again, and a record of what the working copy has synced, which is what lets `pull` delete a photo that was removed somewhere else without ever deleting one that was not.

## Setting it up

Add the block next to `sites`:

```yaml
media:
  store: { type: fs, dir: ../originals }
```

See [Configuration](configuration.md#media) for every key. Then, once per repository:

1. Print the patterns that git should ignore, and add them: `coffer media gitignore >> .gitignore`. The list ends with `.env.local`, the file that holds the credentials of a bucket (see [below](#credentials-and-envlocal)): it must never be committed.
2. Tell git to keep the line ends of the lock file: add `media.lock.json text eol=lf` to `.gitattributes`. (A checkout with CR LF line ends is still read, but the lock file is always written with LF.)
3. If the originals are already in git, remove them from the index without deleting the files (`git rm -r --cached` on their folders), run `coffer media lock` and `coffer media push`, and commit. Old history still holds them; rewriting history is a separate decision that coffer does not make for you.

With a bucket as the store, add the credentials (`.env.local`) and install the [git hooks](#git-hooks) once, with `coffer hooks install`; from then on committing refreshes the lock file, pushing uploads the originals and checking out or merging fetches them, without a command.

On a second computer: clone, create `.env.local` (the one setup step that cannot be in the repository), then run `coffer media pull`, or `coffer hooks install` followed by a checkout. You get the complete working copy including all originals.

## Day to day

```
# after adding, replacing or deleting photos
coffer media lock        # record the originals in media.lock.json
coffer media push        # upload what the store lacks
# commit media.lock.json and push the commit as usual

# on the other computer, after pulling the commit
coffer media pull        # fetch new and changed originals, delete removed ones
```

Run `coffer media pull` before `coffer media lock` on a working copy that has just been cloned or that received a lock it has not pulled yet. `lock` is safe either way: an entry of the lock whose photo this copy has never fetched stays in the lock (see below), so it cannot make anybody else lose that photo.

`coffer media status` shows what differs at any time. Run `coffer media push` before you share the commit: someone who receives a lock file whose objects were never uploaded cannot fetch those photos.

## The commands

All commands take `--config <path>` (a value that starts with `-` is taken for a forgotten path, as in `--config --force`, and is a usage error; write `--config=-name.yaml` for such a file name). They exit with 0 on success, 1 on a failure (a conflict, an entry that could not be handled, a store that cannot be reached, a configuration problem) and 2 when the command was called wrongly (no subcommand, an unknown subcommand, an unknown flag), so a script or a git hook can tell the two apart.

| Command | What it does |
| ------- | ------------ |
| `coffer media status` | Compares the working copy with the lock file: **new** (not in the lock), **changed** (different content than the lock), **deleted** (in the lock, removed here after a sync), **missing** (in the lock, never fetched here), and two more that `pull` acts on: **outdated** (the lock has newer content than the synced copy here) and **removed** (no longer in the lock, still here as it was synced). `--remote` also asks the store which objects it lacks. |
| `coffer media lock` | Finds the originals, hashes them and writes the lock file. A file whose size and modification time are unchanged since the last run is not read again (the hashes are cached in `.coffer/media-cache.json`; a file modified in the last few seconds is always read again). Files are read in chunks, so a large video is never held in memory. Writes nothing if the result is the same. An entry of the existing lock whose file is not here is **kept** (and reported) unless this working copy had the file in sync and it was deleted here since: that is a deliberate delete and the entry is dropped. So a fresh clone, or a copy whose `pull` was interrupted, cannot write a lock that makes other copies delete photos it merely never fetched. A kept entry that `media.include` no longer matches is dropped with a warning. A new local file that differs from a kept entry only by letter case is an error until you pull or rename. |
| `coffer media push` | For every entry of the lock, makes sure the store has the object `originals/{sha256}`: uploads it from the local file when it is missing, after checking that the file still has the hash the lock says. An entry whose content the store lacks and that cannot be uploaded is an error, and the message says what to do: for a file that is missing here after a sync or was changed after `lock`, run `coffer media lock` or fetch the right file; for an entry this working copy never fetched (a kept entry), run `coffer media pull` on a working copy that has the file, because locking here would change nothing. With no lock file, or a lock that lists nothing, there is nothing to upload and the store is not even opened, so `push` needs no credentials then. |
| `coffer media pull` | Brings the working copy in line with the lock; see below. `--dry-run` says what would happen and changes nothing, `--force` replaces local files that differ from the lock even though they were never synced (their content is lost) and allows an empty lock to delete every synced file (see below), `--restore` fetches files again that were synced and then deleted here. |
| `coffer media gitignore` | Prints the ignore patterns for the content repository: the `include` patterns, `.coffer/` and `.env.local`. |

## The lock file

`media.lock.json` is valid JSON laid out for version control: one line per original, sorted by path, nothing else on the line.

```
{"version":1,"files":[
{"path":"content/journal/trip/IMG_0001.JPG","sha256":"3f4c...","size":4182344},
{"path":"content/journal/trip/clip.mp4","sha256":"9a01...","size":88123004}
]}
```

- The order is the order of the UTF-8 bytes of the path, so it is the same on every platform and in every locale (uppercase before lowercase).
- Paths use `/`, are relative to the folder of `coffer.yaml`, and the file uses LF line ends with a final newline.
- Adding, replacing or removing a photo changes exactly one line, so two people who add different photos merge without a conflict. (Two people adding at the very end of the list touch the same neighbouring line, because the last entry has no comma; git reports that as an ordinary conflict. Keep every line of both sides and run `coffer media lock`, which rewrites the file.)
- The file is read strictly. A line that is not exactly what `lock` writes, a duplicate, an entry out of order, a bad hash or size, a merge conflict marker, or two paths that a case-insensitive file system would take for one file (`A.jpg` and `a.jpg`) is an error that names the line. `coffer media lock` does not need the old file to be valid; it writes a new one.
- Every path must also be a plain path (see [What is checked](#what-is-checked)) that matches `media.include`.

## What `pull` changes and what it never does

For each entry of the lock:

| Local file | Result |
| ---------- | ------ |
| absent | Downloaded. (Unless it was synced earlier and deleted here since: it is left deleted, and `--restore` fetches it.) |
| same content as the lock | Nothing. |
| different, and it is exactly what was synced before (the lock moved on) | Replaced by the lock's content. |
| different, and not known to be synced | **Conflict.** Nothing is changed for that file; the command exits 1 and names it. Keep your file and run `coffer media lock`, or run `coffer media pull --force` to replace it. |

For each file the working copy synced earlier that the lock no longer lists:

| Local file | Result |
| ---------- | ------ |
| exactly the content that was synced | Deleted. |
| changed since | Kept, and reported. It counts as your own file from now on. |
| absent | The record is forgotten. |

A file counts as **synced** when it is known to be in the store with exactly this content: after `push` uploaded or confirmed it, and after `pull` downloaded it (or found it already in place and confirmed that the store has it). Locking does not make a file synced, because a lock can be undone by a checkout or a reset, while the store keeps the photo. So a file that was never pushed or pulled is never deleted, whatever the lock says, and neither is a file that was modified after the sync. `.coffer/media-state.json` holds the record; if it is lost or damaged, the working copy simply counts as having synced nothing, and nothing is deleted.

Before `pull` replaces or deletes a file because it is "exactly what was synced", it reads the file again; it does not rely on the size and modification time in the hash cache, which an edit made with `exiftool -P`, `rsync -t` or `cp -p` leaves unchanged. Just before the change it compares size and time once more, in case the file is being written. A file that turns out to be different is a conflict (or is kept), never lost. A small window remains between that fresh hash and the delete or the rename: a program that writes to the file in exactly that moment, and leaves its size and modification time as they were, could lose its write. It is a matter of milliseconds and needs a writer that rewrites a photo that was just removed from the lock; nothing in git or in coffer does that.

When there is no lock file at all, `pull` does nothing, because a missing file must not read as "everything was removed". An empty lock (the two lines `{"version":1,"files":[` and `]}`) does mean that nothing belongs in the repository, but because a bad merge or a checkout of the wrong branch can produce one too, `pull` refuses to delete synced files on its word: it reports an error, deletes nothing and exits 1, and `coffer media pull --force` (after a look with `--dry-run`) does it. An empty lock that leaves nothing to delete is fine.

`pull` can be interrupted and run again at any time. Each download goes to a temporary file next to its target (a name starting with a dot and ending in `.part`), is hashed, and is renamed into place only when the hash and size are what the lock says; a failed download leaves no partial original. A second run finds the files already in place and finishes the rest. Empty folders are left behind when files are deleted, and a download that fails leaves the empty folders it made.

## What goes into `.gitignore`

`coffer media gitignore` prints the `include` patterns (git understands this glob syntax, including `**` and `[jJ]`-style classes), `.coffer/` and `.env.local`:

```
content/**/*.[jJ][pP][gG]
content/**/*.[jJ][pP][eE][gG]
...
.coffer/

.env.local
```

Append it to the `.gitignore` next to `coffer.yaml`. Do not ignore the lock file. git also ignores hidden files that match, while coffer never treats hidden files as originals; that does no harm.

SVG files are not originals by default: they are small text, they diff and merge in git, and coffer reads them when it builds. If you do want SVG in the store, list it in `media.include`.

Keep the patterns in `media.include` in step with the folders you really keep photos in; a pattern that is too wide (`**/*.png`) also takes screenshots in documentation folders. Folders named `node_modules` and anything starting with a dot are never searched.

## Stores

A store keeps objects by their SHA-256 and has three operations: `has(key)`, `put(key, file)` and `get(key, file)`. The commands know nothing else about it. The `put` of a store checks that the file has the hash it is stored under, and `get` checks the hash again; `pull` then checks it a third time before the file replaces anything.

**`fs`** keeps the objects in a folder, `{dir}/originals/{sha256}`. Writes go to a temporary file and are renamed, so a reader never sees half an object, and the key must be 64 lowercase hexadecimal characters (it can never carry a path). The folder is made by the first `push`. It suits tests, a second disk, and a network drive. `dir` is a plain path: `~` and environment variables are not expanded (a `dir` that starts with `~` is a configuration error, and `$HOME/originals` would be a folder named `$HOME` below the configuration folder), so write the full path or one relative to `coffer.yaml`. The checks of the folder below look at the names of the paths as written, not at where links lead: a link that points into a content folder is not seen through. It must be a folder of its own: the configuration refuses a `dir` that is inside a content folder or contains one (a broad `include` pattern would take the objects for originals), that is or contains the folder of `coffer.yaml`, or that is inside `.coffer`.

```yaml
media:
  store: { type: fs, dir: /mnt/nas/originals }
```

**`s3`** keeps the objects in an S3-compatible bucket, such as Cloudflare R2, Backblaze B2, MinIO or AWS S3, under `{prefix}/originals/{sha256}`:

```yaml
media:
  store:
    type: s3
    endpoint: https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com
    bucket: my-media
    region: auto
    # prefix: site-one                                     (optional folder in the bucket)
    # accessKeyIdEnv: COFFER_MEDIA_ACCESS_KEY_ID          (the default)
    # secretAccessKeyEnv: COFFER_MEDIA_SECRET_ACCESS_KEY  (the default)
```

A key written in the file, or a value that looks like a key where the name of a variable belongs, is a configuration error: the block only NAMES the environment variables that carry the credentials (see [Credentials](#credentials-and-envlocal)).

- **Addresses are path-style**: `{endpoint}/{bucket}/{prefix}/originals/{sha256}`. R2 and nearly every S3-compatible server accept them, and they need no certificate or DNS entry per bucket. The key is always the 64 hexadecimal characters of a SHA-256, never anything taken from a file name.
- **`endpoint` must be https.** A `${NAME}` in it stands for an environment variable (or a line of `.env.local`); the value may only hold letters, digits, `.`, `_` and `-`, and not only dots. The configuration has no way to allow plain http. (The in-process server of the tests is reached through an option of the code, `allowInsecureLoopback`, that works for `localhost`, `127.0.0.1` and `[::1]` only and that no configuration can set.)
- **Requests are signed** with AWS Signature Version 4 (the small library aws4fetch does the signing). The requests themselves are sent with Node's http client, so that an upload is a stream from the disk with a known length and a download is a stream to the disk: a video is never held in memory. Multipart uploads are not used; a single request is fine up to about 100 MB, far above a photo.
- **The key is the payload hash.** The file is hashed first, so an upload is signed with `x-amz-content-sha256: {sha256}` and the server checks the body against it; R2 and S3 refuse a body that does not match. The upload is hashed once more while it is sent, and a download is hashed while it is written; a download that is not the content of its key is removed and reported as corrupt, and is not retried.
- **Retries.** A network error, a timeout, HTTP 408, 429 and 5xx are tried again, up to 5 attempts and 10 minutes in all, waiting 0.5 s, 1 s, 2 s and 4 s (with jitter, at most 20 s), or as long as a `Retry-After` header asks (at most 60 s). 400, 403 and 404 are final. A connection that stays silent for 30 seconds is given up on. A download that stops half way starts again from the beginning.
- **Redirects are not followed.** A signed request is never sent on to another host; a redirect is an error that says to check `endpoint` and `region`.
- **Messages hold no secret.** The credentials are removed from every message; the start of an error answer of the server is shown, cut short and with anything that looks like a key taken out.
- **Originals are private objects.** Nothing here makes an object public, and the site publishes only the images derived from the originals, never the originals themselves.

## Cloudflare R2

1. In the Cloudflare dashboard, open **R2 Object Storage** and create a bucket, say `my-media`. Leave public access off: do not enable the `r2.dev` address or a custom domain for it.
2. Open **R2 > Manage API tokens** and create an API token with the permission **Object Read & Write**, restricted to that one bucket. Note the **Access Key ID** and the **Secret Access Key** (shown once) and your **account id** (on the same page, and in the address of the dashboard).
3. In `coffer.yaml`:

   ```yaml
   media:
     store:
       type: s3
       endpoint: https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com
       bucket: my-media
       region: auto
   ```

   The endpoint of R2 is `https://{account id}.r2.cloudflarestorage.com` and the region is always `auto` (the default). Do not put the bucket into the endpoint; coffer adds it to the path.
4. Create `.env.local` next to `coffer.yaml` (see below) with the two keys and the account id.
5. Run `coffer media status --remote`: it asks the bucket which objects of the lock it lacks, so it also shows whether the credentials work. Then run `coffer media push`.

For a CI job, put the same values into the secrets of the workflow and hand them to the step as environment variables; no file is needed. The names in the configuration are the names of the variables (`accessKeyIdEnv` and `secretAccessKeyEnv`), so a workflow whose secrets have other names maps them in the `env:` block of the step.

## Credentials and `.env.local`

A key is never read from `coffer.yaml`; the block names the variables that carry it. coffer looks for each variable in two places, in this order:

1. the environment of the process;
2. the file `.env.local` in the folder of `coffer.yaml`.

The file is the one setup step on a new computer:

```
COFFER_MEDIA_ACCESS_KEY_ID=your-access-key-id
COFFER_MEDIA_SECRET_ACCESS_KEY=your-secret-access-key
CLOUDFLARE_ACCOUNT_ID=your-account-id
```

(The values here are placeholders; replace them with your own.) The file is read as data: `NAME=value` lines, blank lines, `#` comments, an optional `export`, optional single or double quotes around a value, nothing expanded or executed. A quoted value ends at its closing quote, so `KEY="abc" # my key` is `abc` (the quotes and the comment are dropped); inside quotes `#` is part of the value, and in an unquoted value a `#` right after a character is too (`KEY=ab#cd`), while ` #` (a space first) starts a comment. A missing file is fine. A variable of the environment wins over the file. A `.env.local` that is a link pointing outside its folder is not read.

**`.env.local` holds secrets and must be ignored by git.** `coffer media gitignore` lists it; make sure it is in your `.gitignore` before you create the file. coffer never prints, logs, puts into a message or writes anywhere a credential. When it reads `.env.local` and the folder is in a git repository, it checks the file with git and prints one warning (not an error; the command carries on) if git tracks it (`git rm --cached .env.local` stops that) or does not ignore it. Outside a repository, or without git, it says nothing.

When something is missing, a command that needs the store (`push`, `pull`, `status --remote`) prints one message, not one per object. It names every variable that is not set, shows where the file goes and a template with placeholder values, and exits with 1. `lock`, `status` and `gitignore` never need credentials, and neither does `push` when the lock lists nothing.

## Git hooks

`coffer hooks install` makes the media commands run on their own. It writes five small scripts to `.coffer-hooks/` in the root of the repository and sets `core.hooksPath` to that folder in the **local** configuration of this repository (never `--global` or `--system`). Running it again changes nothing when nothing is out of date.

| Hook | When git runs it | What it does |
| ---- | ---------------- | ------------ |
| `pre-commit` | before every commit | Does what `coffer media lock` does and stages the lock file (its path comes from `media.lock`). Does nothing without a `media` block. If it fails, the commit is stopped. |
| `pre-push` | before every push | Does what `coffer media push` does: uploads what the store lacks. If that fails (no credentials, the bucket cannot be reached, a file does not match the lock) **the push is aborted**, so nobody receives a lock file whose photos are not in the store. Git sends the refs it is about to push to the hook, and the hook reads them: a push that **only deletes** branches or tags (`git push origin --delete topic`, `git push origin :topic`) sends no commits and no lock file, so the hook does nothing, touches no store and needs no credentials. A push that creates or updates any branch **or tag** is checked, because even a tag can point at commits whose lock lists originals that are not uploaded yet Lines the hook cannot understand count as a push that may send something, so it is checked as well. (`--no-verify` skips the check.) Run by hand with nothing on its standard input, the hook sees no refs and does nothing. With no lock file, or a lock that lists nothing, there is nothing to upload and no credentials are needed either. |
| `post-checkout` | after a branch checkout (not after checking out single files) | Does what `coffer media pull` does. |
| `post-merge` | after a merge, or a pull that merged | Same. |
| `post-rewrite` | after an amend or a rebase | Same. |

The three `post-*` hooks never fail the git operation they follow (git could not undo it anyway): when something goes wrong they say what, and exit 0. Without credentials they skip with one line, and `coffer media pull` does the work later. They use the same `pull` as the command, which never deletes a file that was not synced, never overwrites a file you changed, and is never run with `--force`.

**What the hooks do and do not know.**

- The lock file is a property of the **working copy**. `pre-commit` writes it from the files on disk, not from what is staged, so a partial commit (`git commit path/to/file`, `git add -p`) can contain a lock that lists photos belonging to files that are not in that commit. That does no harm: the photos are in the store (or will be, at the next push), and a lock entry for a photo nobody uses is only a line in a file.
- `pre-push` uploads what the lock file **in the working tree** lists, not what the lock of the commit being pushed lists. When you push an older commit, or another branch than the one checked out, the originals that commit's lock lists may not be uploaded by this hook; run `coffer media push` in a working copy that has them.
- With several `git worktree`s, `core.hooksPath` is a relative path that git resolves from the root of each working tree, so `.coffer-hooks/` must exist in each: run `coffer hooks install` in every worktree (or commit `.coffer-hooks/`). A worktree without the folder runs no coffer hooks at all.
- The S3 store sends its requests with Node's own http client, which does not read `HTTPS_PROXY`, `HTTP_PROXY` or `NO_PROXY`. Behind a proxy that outgoing connections must use, the store cannot be reached.

**What the scripts are.** POSIX `sh` with LF line ends (they run under Git for Windows, Linux and macOS), strict (`set -eu`), everything quoted, no bashisms. A script only finds coffer and calls `coffer hooks run <hook>`, which holds the logic; it goes to the root of the repository first. The second line is a marker with a version: a script with the marker is coffer's and is updated by `install`; a file without it is yours and is never overwritten without `--force`.

**Where the scripts look for coffer**, in this order: the program named by the environment variable `COFFER`; `node_modules/.bin/coffer` in the repository (where `npm install` puts it, and where `npx --no-install coffer` would find it as well); `coffer` on the `PATH`. If there is none, a guarding hook (`pre-commit`, `pre-push`) fails with a message that says to run `npm install`, and a following hook only prints it. Node itself must be on the `PATH` of git (a graphical git client may not have it; start git from a terminal then).

**The executable bit.** On Linux and macOS the files are written with mode 755. Git for Windows runs hooks whether or not the file has the bit, and a Windows file system has none. You do not have to commit `.coffer-hooks/`: it is generated, `install` recreates it, and an npm `prepare` script that runs `coffer hooks install` does so on every `npm install`. If you do commit it, `coffer hooks install` sets the mode in the git index (`git update-index --chmod=+x`) for the files git already tracks; for the first commit use `git add --chmod=+x .coffer-hooks/*`, so that a checkout on Linux gets runnable files.

```
coffer hooks install [--force] [--config <path>]   write the scripts and set core.hooksPath
coffer hooks status                                say whether they are installed and current (exit 1 if not)
coffer hooks uninstall                             remove the scripts coffer wrote and unset core.hooksPath
```

- `install` refuses to replace a `core.hooksPath` that points elsewhere (another tool such as Husky is using it) and refuses to overwrite a hook file that coffer did not write; it changes nothing at all then. `--force` replaces both. Hooks in `.git/hooks` stop running once `core.hooksPath` is set; `install` lists them.
- `--config <path>` is for a repository whose `coffer.yaml` is not in the root: the path (relative to the root, inside the repository) goes into the scripts. Without it the hooks use the `coffer.yaml` in the root or above it, and do nothing at all if there is none; `install` warns when it finds no `coffer.yaml` there, because that is the easy mistake in a repository whose site lives in a subfolder.
- `COFFER_SKIP_HOOKS=1` in the environment turns every coffer hook off, for example for a CI job that makes commits.

**Bypassing a hook.** `git commit --no-verify` skips `pre-commit`: the lock file is then not refreshed, so the commit may not list a photo you added (the next commit that runs the hook adds it). `git push --no-verify` skips `pre-push`: the originals are then not uploaded, and everyone who fetches the lock file cannot get those photos until you run `coffer media push` (`coffer media status --remote` shows which are missing). Nothing is lost by either: the originals are still in your working copy.

## What is checked

The lock file comes out of a git repository, so it can be written by someone else. Everything in it, and everything in the state file, is treated as untrusted:

- A path is accepted only when it is relative and written with `/`; has no empty, `.` or `..` name; no name starting with a dot (so `.git`, `.coffer` and hooks are out of reach); no `:` (drive letters, data streams) or other character Windows forbids; no device name such as `CON` or `NUL`; no name ending in a dot or a space; no control or bidirectional-control character; and names of at most 255 bytes and a path of at most 1024.
- Every path must match `media.include`, so a lock cannot name `coffer.yaml` or a script. Entries that do not match stop the command before anything is written. As a second guard, the configuration refuses an `include` pattern that matches the lock file or the configuration file (such as `**/*.json`).
- A path is turned into a place on disk one name at a time without following links. A symbolic link or a junction anywhere on the way (even one that points inside the working copy), a folder where a file belongs, or a file where a folder belongs is refused for that entry; the other entries are still handled and the command exits 1.
- `lock` leaves symbolic links out (and says so), and refuses two local files that differ only in case.
- The files in `.coffer/` are written atomically, and a damaged one counts as empty.
- `.env.local` is read as data and never executed, and a link at that name that points outside its folder is refused. Credentials are kept out of every message, log and file.
- `include` patterns are matched by the linear-time matcher described under [guides](docs-sources.md#guides), never by a regular expression made from the pattern.
