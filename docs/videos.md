# Videos

A post can show videos hosted on YouTube, Vimeo, PeerTube instances, Rutube and VK Video, videos of any other host that the site describes in its configuration, and `.mp4` or `.webm` files beside the post. A video can start and stop at given times, list chapters, and be the target of links in the text that jump to a time. Each video has a preview image, fetched from the host at build time or chosen by the author.

Pages stay readable without JavaScript: a remote video is a preview that links to the video's page on the host. A small script loads the host's player when the reader clicks (see [Without JavaScript](#without-javascript)).

## Writing a video

### An address on its own line

A paragraph that is only a video address becomes a video:

```markdown
I copied the joint from https://youtu.be/aBcD3fGh1_- last week.

https://youtu.be/aBcD3fGh1_-

[https://youtu.be/aBcD3fGh1_-](https://youtu.be/aBcD3fGh1_-)
```

Only the second paragraph becomes a video. The rules:

- the paragraph is at the top level of the text, not inside a list, a quote, a footnote or a directive;
- its text, without surrounding spaces, is exactly one address, or one address in angle brackets (`<https://...>`);
- a rule recognises the address (see [Providers](#providers)).

An address in a sentence, or written as `[text](address)`, stays a link. An address that no rule knows stays a link and is not an error. The video then has no title of its own, and its times come from the address (`?t=83` and the like).

### `::video`

The directive gives a video a title, times and other settings. It stands on its own line:

```markdown
::video[Fitting the drawer]{src="https://youtu.be/aBcD3fGh1_-" start="1:23" end="4:00"}
```

The text in square brackets is the title. It is optional and read as plain text: emphasis or links in it are reduced to their text.

| Attribute | Required | Value |
| --- | --- | --- |
| `src` | yes | An `http://` or `https://` address of a video, or the file name of a [local video](#local-videos). |
| `start` | no | A [timecode](#timecodes) at which the video starts. It replaces a start time in the address; `start="0"` removes one. |
| `end` | no | A timecode at which the video stops. It replaces a stop time in the address. It must be later than the start. |
| `poster` | no | An image beside the post, processed like a Markdown image. It replaces the preview of the host, so the build makes no request for the video. |
| `load` | no | `click` or `iframe`: how this video loads (see [Loading](#loading-click-or-iframe)). It overrides the site's `video.load`. Not allowed on a local video. |
| `id` | no | A name for links to times (`video="..."`) and for the HTML `id`. It starts with a lower-case letter and holds only lower-case letters, digits and `-`, and it is unique in the text. |

No other attribute is allowed. A `src` that starts with `/` or `//`, or with another scheme (`ftp:`, `data:`), is an error.

### Chapters: `:::video`

Written as a container, the same directive holds a list of chapters:

```markdown
:::video[Fitting the drawer]{src="https://youtu.be/aBcD3fGh1_-?t=12" id="drawer"}
- 0:12 Marking out
- 1:05 Sawing the *tails*
:::

The glue-up starts at :t[2:40].
See :t[the dry fit]{at="1:05" video="drawer"} first.
```

- The body is one list, numbered or not, and nothing else.
- Each item starts with a timecode in the form `83`, `1:23` or `1:02:03`, a space and the title of the chapter. The title may hold emphasis, code and links.
- The times increase from item to item, and each lies in the part of the video that plays: not before the start, and before the end when there is one.
- A container without a body is a video without chapters.

The page shows the chapters below the video, each time a link that plays the video from there.

### Links to a time: `:t`

`:t` makes a link in the text that plays a video from a time. The second paragraph of the example above has two:

- `:t[2:40]`: the text in square brackets is the time, written as any [timecode](#timecodes). The link shows it as written.
- `:t[the dry fit]{at="1:05" video="drawer"}`: with `at`, the text in square brackets is the text of the link and `at` is the time.

Without `video`, the link plays the nearest video before it in the text. With `video`, it plays the video with that `id`, which may also come later in the text. The time must lie in the part of the video that plays, as for chapters. A seek link cannot be inside a link, and its text cannot hold one.

### Timecodes

A timecode is a position in a video in whole seconds, written in one of these forms:

| Form | Example | Seconds |
| --- | --- | --- |
| seconds | `83` | 83 |
| minutes and seconds | `1:23` | 83 |
| hours, minutes and seconds | `1:02:03` | 3723 |
| units | `1m23s`, `1h`, `90s` | 83, 3600, 90 |

Minutes and seconds after a colon have two digits (`1:05`, not `1:5`). The largest time is `99:59:59`. Spaces, decimals and signs are not allowed.

### Words, links and ids

The title of a video does not count toward the reading time; the titles of chapters and the texts of seek links do. Video addresses are not links of the text, so the build does not check them like links, and a video is never the first image of a post. The HTML `id` of a video is `video-` followed by its `id`, or by its number in the text counted from 1 (`video-1`). It is among the `ids` of the text, so a link to `#video-drawer` is checked like a link to a heading.

## Providers

| Provider | Addresses | Start | End | Chapters and seek links | Preview |
| --- | --- | --- | --- | --- | --- |
| YouTube | `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/embed/ID`, `youtube.com/shorts/ID`, `youtube.com/live/ID`, `youtube-nocookie.com/embed/ID` | yes | yes | yes | from the host |
| Vimeo | `vimeo.com/ID`, `vimeo.com/ID/HASH`, `player.vimeo.com/video/ID?h=HASH` | yes | no | yes | from the host |
| PeerTube | `https://HOST/w/ID`, `/videos/watch/ID`, `/videos/embed/ID`, for each host in `video.peertubeHosts` | yes | yes | yes | from the host |
| Rutube | `rutube.ru/video/ID/`, `rutube.ru/play/embed/ID/`, `rutube.ru/shorts/ID/` | yes | no | yes | from the host |
| VK Video | `vkvideo.ru/videoOID_ID` (also on `vk.com` and `vk.ru`), `vk.com/video_ext.php?oid=OID&id=ID&hash=HASH` | no | no | no | only a `poster` |
| your own | what the site's rules say | with `startParam` | with `endParam` | with `startParam` | with `thumbnail` or `oembed` |

Addresses may start with `http://` or `https://`, and `www.` is accepted where the host uses it. Times are read from the address where the host puts them: `t` and `start` in the query and `t` in the fragment for YouTube (`end` for the stop time), `#t=` for Vimeo, `start` or `t` (and `stop`) for PeerTube, `t` for Rutube. A time may be written in any [timecode](#timecodes) form, such as `?t=1m30s`.

The players are loaded from `youtube-nocookie.com` for YouTube and with `dnt=1` for Vimeo, the privacy settings of both hosts.

PeerTube has no built-in addresses, because there are many instances: list the host of each instance whose videos you show in `video.peertubeHosts` (see [Configuration](#configuration)). Some VK videos play only with the `hash` of VK's export dialog, so paste the address that the dialog gives, with its parameters in the order it writes them. VK has no public preview service: without a `poster`, a VK video has an empty preview.

### What a provider cannot do

Asking for something a provider cannot do is not an error. The build ignores it and writes a warning:

```text
content/journal/plane/index.md:5:1: Vimeo videos cannot stop at a given time; end="20" is ignored
```

| Request | Without support |
| --- | --- |
| `start` | The video starts at the beginning. |
| `end` | The video plays to the end. |
| chapters | They are listed, with their times as text and not as links. |
| a seek link | Its text is shown without the link. |

A time in the address never causes a warning, because only the time parameters that the provider understands are read. The start and the end then also limit what chapters and seek links may point at, so a Vimeo video with `start="90" end="30"` is valid: the end is dropped first.

### Your own hosts

A host that is not built in is described by a rule in `video.rules`: a regular expression that recognises its addresses, and templates of the player, page and preview addresses. The configuration example below adds a host with a rule. The pattern must match the whole address and have a named group `id`; the templates use the named groups of the pattern as `{name}`:

```markdown
https://tube.example/v/abcd1234?t=15

https://video.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv
```

With the example configuration, the first paragraph is a video of the host "Example Tube" that starts at 15 seconds, and the second a PeerTube video.

A rule can also name a built-in provider, to recognise an address form that the built-in rules do not know; the player and page addresses are then those of the provider, built from the groups of the pattern. A PeerTube rule needs the group `host`, a VK Video rule the group `oid`. See [`video`](configuration.md#video) for every key of a rule.

## Loading: click or iframe

A remote video loads in one of two ways, set for the site by `video.load` and for one video by `load`:

- **`click`** (the default): the page shows the preview with a play label, as a link to the video's page on the host. A click puts the host's player in its place and starts it. The page contacts the host only when the reader clicks.
- **`iframe`**: the page holds the host's player from the start, loaded lazily (`loading="lazy"`), so the browser contacts the host when the video comes near the screen. The reader starts it as usual.

Nothing plays when a page loads.

## Previews

For each remote video the build decides on a preview, in this order:

1. With `poster`, the poster image is processed like any image of the post and is the preview. No request is made. A poster that does not exist fails the build.
2. A preview of the video in the cache is used. No request is made.
3. With `video.fetchPreviews: false`, or for a provider that offers no preview (VK Video, or a rule without `thumbnail` and `oembed`), the video has no preview and no title from the host.
4. Otherwise the build fetches the preview from the host.

Fetching asks the host's oEmbed service (Rutube: its video API) for the title and the address of the thumbnail, then downloads the thumbnail. A rule with `thumbnail` downloads the thumbnail directly. Each request is a `GET` with the header `User-Agent: coffer/{version}` and may take 10 seconds. The thumbnail must be a JPEG, PNG or WebP image of at most 10 MiB. The image pipeline turns it into WebP variants named `{provider}-preview`, published under `/img/` like the images of the post, with location and camera metadata removed. A fetched preview is not one of the author's images, so the manifest records it with the video and not under `images`.

The title shown is the video's own title in square brackets, else the title from the host, else the word "Video" (the UI string `video.untitled`). The caption under the video shows the title, except in that last case, and a link to the video on the host ("Watch on YouTube").

### The cache

A preview that was fetched is kept in `.cache/videos/` beside the configuration file (in `videos/` of the build's cache folder, when one is given): `{key}.json` with the title and the name of the thumbnail, and the thumbnail as `{key}.jpg`, `.png` or `.webp`. The key is the SHA-256 of the address of the video's page without a time, so every video of a site with the same address shares one entry, and a build makes at most one request sequence for it. Entries never expire; delete the folder, or one entry, to fetch again.

A build on a fresh checkout, as in CI, has no cache and fetches every preview again. Keep `.cache/videos/` between runs, give videos a `poster`, or set `fetchPreviews: false`. With `fetchPreviews: false` the build makes no request at all, but still uses the previews already in the cache.

### When fetching fails

A failure never fails the build. The video has no preview, a warning names the video and the reason, and nothing is cached, so the next build tries again. When the title was fetched before the failure, it is still used.

```text
content/journal/clip-test.md:1:1: video "https://youtu.be/aBcD3fGh1_-": preview not fetched: https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaBcD3fGh1_- answered 404
```

The reasons are: the address `answered` a status other than 200, `did not answer within 10000 ms`, `could not be reached`, `did not return a JSON object`, `returned no thumbnail`, returned a type that is not a JPEG, PNG or WebP image, `is larger than 10 MiB`, or the image `could not be decoded`.

## Local videos

A video file beside the post is written with its file name, found like a Markdown image of the post:

```markdown
::video[Glue-up, sped up]{src="Glue Up.MP4" start="5" poster="glue.jpg"}
```

- The file must be `.mp4` or `.webm`, in any capitalisation.
- It is copied unchanged into the folder of the post's page. Its published name is the original's name in lower case, with every run of other characters than `a` to `z` and `0` to `9` turned into one `-`: `Glue Up.MP4` becomes `glue-up.mp4`. A file used twice is copied once; two different files that would get the same name fail the build and name both.
- The page shows it in `<video controls preload="metadata">`, with the `poster` as the picture before it plays and a download link for browsers that cannot play it. `start` and `end` become a media fragment of the address (`glue-up.mp4#t=5`).
- coffer does not convert videos or take pictures from them. Without a `poster`, the browser shows what it shows for the file.
- The file is published as it is, so the [location and camera metadata policy](location-policy.md), which covers pictures, does not touch it. Remove location data from the file yourself.
- Local videos exist only in posts. On the home page, a project page, a guide, a README section or a press kit description, a file name is an error: there, use a remote video.

With a [`media` block](media.md), `.mp4` and `.webm` files are originals by default, so they stay out of git like photos.

## Without JavaScript

The figure of a video works without a script:

- the preview of a remote video is a link to the video's page on the host;
- a chapter and a seek link open that page at their time;
- a local video plays in the browser's own player, and its chapters and seek links open the file at their time (`#t=`).

A page that has at least one video loads `/assets/video.js` with `defer`. The script puts the host's player in place of the preview on a click, and makes chapters and seek links play the video on the page from their time: a local video jumps there, a remote player is reloaded at the time. It loads no other script and does not talk to the hosts' players, so it works the same for every host. A click with a modifier key or another mouse button keeps its usual meaning, such as opening a new tab.

## Where videos appear

- **Posts** show the figure in the text.
- **Other texts** (the home page, project pages, guides, README sections and press kit descriptions) show remote videos the same way and load the script; their warnings name their file.
- **List pages that show whole posts** (a blog with `index: full`) show each video with the preview of the post page; its ids start with the post's slug.
- **Feeds** hold the figure in click mode, without the `data-` attributes and with absolute addresses, so a feed reader shows the preview as a link to the host (see [Feeds](feeds.md)).
- **Summaries** (the description of a page, the feed summary and the share summary) leave videos out.
- **The manifest** lists the videos of each post (see [Building a site](build.md#the-build-manifest)): `index`, `id`, `provider` (`file` for a local video), `src`, `title` (null when none is shown), `start`, `end`, `load`, `preview` and `file` (site addresses, or null) and the `chapters` in seconds.

## Configuration

Every key of `video` is optional; see [`video`](configuration.md#video) for the details:

```yaml
video:
  load: click
  fetchPreviews: true
  builtinRules: true
  peertubeHosts: [video.example.org]
  rules:
    - pattern: 'https://tube\.example/v/(?<id>[a-z0-9]{8})(?:[?#].*)?'
      provider: generic
      name: Example Tube
      embed: 'https://player.tube.example/e/{id}'
      watch: 'https://tube.example/v/{id}'
      startParam: t
      autoplayParam: autoplay
      thumbnail: 'https://img.tube.example/{id}/cover.jpg'
```

The rules of a site are tried first, then the PeerTube hosts, then the built-in rules (unless `builtinRules` is `false`). The first rule that recognises an address decides.

## The markup

The figure is written by the engine, not by a template, so every theme gets the same HTML. `coffer.css` of the default theme styles it; a theme that replaces the stylesheet styles these classes:

| Class | Element |
| --- | --- |
| `video` | The `<figure>`. `data-video` holds the provider, `data-video-load` the way it loads. |
| `video-preview` | The link around the preview of a remote video in click mode. |
| `video-placeholder` | The empty box that stands in for a missing preview. |
| `video-play` | The play label over the preview. |
| `video-frame` | The box around the player, 16:9. |
| `video-title`, `video-source` | The title and the link to the host in the `<figcaption>`. |
| `video-chapters` | The `<ol>` of chapters; each time is a `<time>`. |
| `video-seek` | A seek link in the text. |

The words come from the UI strings `video.play` ("Play: {title}", the play label and the name of the link), `video.watch_on` ("Watch on {provider}"), `video.untitled` ("Video"), `video.chapters` ("Chapters", the name of the list) and `video.download` ("Download the video"). See [Themes and UI strings](themes.md).

## Errors and warnings

A mistake in a video or a seek link fails the build with the file, the line and the column:

```text
content/journal/plane/index.md:12:1: "https://example.org/x" is not a video address that any rule knows
```

| Message | Cause |
| --- | --- |
| `a video needs src="..."` | No `src`. |
| `a video has no attribute "{name}" (the attributes are src, start, end, poster, load and id)` | An unknown attribute. |
| `src="{src}" is not allowed: a video is an http(s) address or a file beside the post` | A `src` starting with `/`, `//` or another scheme. |
| `"{src}" is not a video address that any rule knows` | An address that no rule recognises. |
| `a local video must be an .mp4 or .webm file: "{src}"` | Another file type. |
| `local video "{src}" does not exist` | No such file beside the post, or a file name in a text that is not a post. |
| `load must be "click" or "iframe"` | Another value of `load`. |
| `load does not apply to a local video` | `load` on a local video. |
| `id must start with a lower-case letter and hold only lower-case letters, digits and "-"` | An invalid `id`. |
| `two videos have the id "{id}"` | The same `id` twice in one text. |
| `{attr}="{value}" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)` | A `start`, `end` or `at` that is not a timecode. |
| `end must be later than start` | An `end` at or before the start (0 when there is none). |
| `the body of a video must be one list of chapters` | Anything but one list in a `:::video`. |
| `a chapter must start with a timecode, a space and a title` | A list item that is not a chapter. |
| `chapters must be in increasing order of time` | A chapter at or before the one above it. |
| `{time} is not within the part of the video that plays` | A chapter or seek link before the start, or at or after the end. |
| `a seek link needs a timecode in square brackets, or at="..."` | `:t[soon]` without `at`. |
| `a seek link has no attribute "{name}" (the attributes are at and video)` | An unknown attribute of `:t`. |
| `a seek link needs a text in square brackets` | Empty brackets with `at`. |
| `a seek link needs a video before it, or video="..."` | No video before the link and no `video`. |
| `there is no video with the id "{id}"` | A `video` that names no video of the text. |
| `a seek link cannot be inside a link` | `:t` in the text of a link. |
| `the text of a seek link cannot hold a link` | A link in the text of `:t`. |
| `poster "{poster}" does not exist` | A `poster` that is not there. |

These are warnings; the build goes on (see [What a provider cannot do](#what-a-provider-cannot-do) and [When fetching fails](#when-fetching-fails)):

| Message |
| --- |
| `{provider} videos cannot start at a given time; start="{value}" is ignored` |
| `{provider} videos cannot stop at a given time; end="{value}" is ignored` |
| `{provider} videos cannot seek to a time; the chapters are shown without links` |
| `{provider} videos cannot seek to a time; the seek link is shown as text` |
| `video "{src}": preview not fetched: {reason}` |

Project trailers (`trailer` in `project.yaml`) are a separate feature with its own rules; see [Projects](projects.md).
