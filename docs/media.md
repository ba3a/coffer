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

1. Print the patterns that git should ignore, and add them: `coffer media gitignore >> .gitignore`.
2. Tell git to keep the line ends of the lock file: add `media.lock.json text eol=lf` to `.gitattributes`. (A checkout with CR LF line ends is still read, but the lock file is always written with LF.)
3. If the originals are already in git, remove them from the index without deleting the files (`git rm -r --cached` on their folders), run `coffer media lock` and `coffer media push`, and commit. Old history still holds them; rewriting history is a separate decision that coffer does not make for you.

On a second computer: clone, then `coffer media pull`. That is the whole setup: you get the complete working copy including all originals.

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

All commands take `--config <path>`. They exit with 0 on success, 1 on a failure (a conflict, an entry that could not be handled, a store that cannot be reached, a configuration problem) and 2 when the command was called wrongly (no subcommand, an unknown subcommand, an unknown flag), so a script or a git hook can tell the two apart.

| Command | What it does |
| ------- | ------------ |
| `coffer media status` | Compares the working copy with the lock file: **new** (not in the lock), **changed** (different content than the lock), **deleted** (in the lock, removed here after a sync), **missing** (in the lock, never fetched here), and two more that `pull` acts on: **outdated** (the lock has newer content than the synced copy here) and **removed** (no longer in the lock, still here as it was synced). `--remote` also asks the store which objects it lacks. |
| `coffer media lock` | Finds the originals, hashes them and writes the lock file. A file whose size and modification time are unchanged since the last run is not read again (the hashes are cached in `.coffer/media-cache.json`; a file modified in the last few seconds is always read again). Files are read in chunks, so a large video is never held in memory. Writes nothing if the result is the same. An entry of the existing lock whose file is not here is **kept** (and reported) unless this working copy had the file in sync and it was deleted here since: that is a deliberate delete and the entry is dropped. So a fresh clone, or a copy whose `pull` was interrupted, cannot write a lock that makes other copies delete photos it merely never fetched. A kept entry that `media.include` no longer matches is dropped with a warning. A new local file that differs from a kept entry only by letter case is an error until you pull or rename. |
| `coffer media push` | For every entry of the lock, makes sure the store has the object `originals/{sha256}`: uploads it from the local file when it is missing, after checking that the file still has the hash the lock says. An entry whose content the store lacks and that cannot be uploaded (the file is missing or was changed after `lock`) is an error. |
| `coffer media pull` | Brings the working copy in line with the lock; see below. `--dry-run` says what would happen and changes nothing, `--force` replaces local files that differ from the lock even though they were never synced (their content is lost) and allows an empty lock to delete every synced file (see below), `--restore` fetches files again that were synced and then deleted here. |
| `coffer media gitignore` | Prints the ignore patterns for the content repository: the `include` patterns and `.coffer/`. |

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

Before `pull` replaces or deletes a file because it is "exactly what was synced", it reads the file again; it does not rely on the size and modification time in the hash cache, which an edit made with `exiftool -P`, `rsync -t` or `cp -p` leaves unchanged. Just before the change it compares size and time once more, in case the file is being written. A file that turns out to be different is a conflict (or is kept), never lost.

When there is no lock file at all, `pull` does nothing, because a missing file must not read as "everything was removed". An empty lock (the two lines `{"version":1,"files":[` and `]}`) does mean that nothing belongs in the repository, but because a bad merge or a checkout of the wrong branch can produce one too, `pull` refuses to delete synced files on its word: it reports an error, deletes nothing and exits 1, and `coffer media pull --force` (after a look with `--dry-run`) does it. An empty lock that leaves nothing to delete is fine.

`pull` can be interrupted and run again at any time. Each download goes to a temporary file next to its target (a name starting with a dot and ending in `.part`), is hashed, and is renamed into place only when the hash and size are what the lock says; a failed download leaves no partial original. A second run finds the files already in place and finishes the rest. Empty folders are left behind when files are deleted, and a download that fails leaves the empty folders it made.

## What goes into `.gitignore`

`coffer media gitignore` prints the `include` patterns (git understands this glob syntax, including `**` and `[jJ]`-style classes) and `.coffer/`:

```
content/**/*.[jJ][pP][gG]
content/**/*.[jJ][pP][eE][gG]
...
.coffer/
```

Append it to the `.gitignore` next to `coffer.yaml`. Do not ignore the lock file. git also ignores hidden files that match, while coffer never treats hidden files as originals; that does no harm.

SVG files are not originals by default: they are small text, they diff and merge in git, and coffer reads them when it builds. If you do want SVG in the store, list it in `media.include`.

Keep the patterns in `media.include` in step with the folders you really keep photos in; a pattern that is too wide (`**/*.png`) also takes screenshots in documentation folders. Folders named `node_modules` and anything starting with a dot are never searched.

## Stores

A store keeps objects by their SHA-256 and has three operations: `has(key)`, `put(key, file)` and `get(key, file)`. The commands know nothing else about it. The `put` of a store checks that the file has the hash it is stored under, and `get` checks the hash again; `pull` then checks it a third time before the file replaces anything.

**`fs`** keeps the objects in a folder, `{dir}/originals/{sha256}`. Writes go to a temporary file and are renamed, so a reader never sees half an object, and the key must be 64 lowercase hexadecimal characters (it can never carry a path). The folder is made by the first `push`. It suits tests, a second disk, and a network drive. It must be a folder of its own: the configuration refuses a `dir` that is inside a content folder or contains one (a broad `include` pattern would take the objects for originals), that is or contains the folder of `coffer.yaml`, or that is inside `.coffer`.

```yaml
media:
  store: { type: fs, dir: /mnt/nas/originals }
```

**`s3`** keeps the objects in an S3-compatible bucket, such as Cloudflare R2, under `{prefix}/originals/{sha256}`:

```yaml
media:
  store:
    type: s3
    endpoint: https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com
    bucket: my-media
    region: auto
    # accessKeyIdEnv: COFFER_MEDIA_ACCESS_KEY_ID          (the default)
    # secretAccessKeyEnv: COFFER_MEDIA_SECRET_ACCESS_KEY  (the default)
```

The block is accepted and every key is checked. Credentials are read from the environment variables the block NAMES; a key written in the file, or a value that looks like a key where the name of a variable belongs, is a configuration error. The S3 client itself is not part of this build yet: `push`, `pull` and `status --remote` with an `s3` store stop with a message that the store is not implemented, and `lock`, `status` and `gitignore` work as usual. The client will be registered as the `s3` kind of store in `src/media/stores.js` (a factory that receives the checked block and the environment and returns a store); the commands call `createStore` and need no change.

## What is checked

The lock file comes out of a git repository, so it can be written by someone else. Everything in it, and everything in the state file, is treated as untrusted:

- A path is accepted only when it is relative and written with `/`; has no empty, `.` or `..` name; no name starting with a dot (so `.git`, `.coffer` and hooks are out of reach); no `:` (drive letters, data streams) or other character Windows forbids; no device name such as `CON` or `NUL`; no name ending in a dot or a space; no control or bidirectional-control character; and names of at most 255 bytes and a path of at most 1024.
- Every path must match `media.include`, so a lock cannot name `coffer.yaml` or a script. Entries that do not match stop the command before anything is written. As a second guard, the configuration refuses an `include` pattern that matches the lock file or the configuration file (such as `**/*.json`).
- A path is turned into a place on disk one name at a time without following links. A symbolic link or a junction anywhere on the way (even one that points inside the working copy), a folder where a file belongs, or a file where a folder belongs is refused for that entry; the other entries are still handled and the command exits 1.
- `lock` leaves symbolic links out (and says so), and refuses two local files that differ only in case.
- The files in `.coffer/` are written atomically, and a damaged one counts as empty.
- `include` patterns are matched by the linear-time matcher described under [guides](docs-sources.md#guides), never by a regular expression made from the pattern.
