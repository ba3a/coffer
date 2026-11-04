# Location and camera metadata

Photos carry more than pixels: a phone records where a picture was taken, a camera records its model, lens and settings. coffer decides, for every image of every post, what happens to both. This page describes the settings and how coffer chooses between them; what the files finally contain is described in [Images](images.md).

## The two settings

The settings are independent. A decision about the location says nothing about the camera, and each is resolved separately for every image.

| Setting    | Values                    | Meaning                                                                                                   |
| ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `location` | `strip`, `coarse`, `keep` | `strip` removes the position and never shows it. `coarse` rounds it to roughly a kilometre, in the file and on a map. `keep` publishes it exactly. |
| `camera`   | `strip`, `keep`           | Whether camera make and model, lens and exposure settings stay in the published image.                    |

For `location`, the values run from the strictest to the most permissive: `strip`, then `coarse`, then `keep`. For `camera`, `strip` is the stricter value.

## Where a setting can be given

From the least to the most specific:

1. **The site**, in `coffer.yaml`: `location.default` and `location.camera`. Both default to `strip`. See [Configuration](configuration.md).
2. **A tag**, in the blog's `tags.yaml`: `location` and `camera` on a tag entry. See below.
3. **A post**, in its front matter: `location` and `camera`.
4. **An image**, in the post's `images` map in the front matter.

For each setting, the most specific level that gives a value wins. That includes a level that is more permissive than a less specific one: a post that says `location: keep` is published with exact locations even if its tag says `strip`. Naming a policy for a post or an image is an explicit choice, and coffer takes it as one. The build report lists the posts that publish exact locations, so a mistake is easy to see before you push.

### Tags

A setting on a tag covers the tag's whole subtree. With this `tags.yaml`

```yaml
hiking:
  location: keep
hiking/private:
  location: strip
```

the tags `hiking` and `hiking/alps/day-2` publish exact locations, while `hiking/private` and `hiking/private/garden` do not. For a given tag, the nearest entry on the way up to the root that has the setting applies, whether it is stricter or more permissive than the entries above it. A tag with no entry on its way up has no tag-level opinion and does not hold back the others.

A post usually has several tags. Each tag yields a value (or none); when the values differ, **the strictest wins**. A post tagged `hiking` (keep) and `hiking/private` (strip) is published with `strip`. Settings are compared one by one, so the location of such a post can come from one tag and its camera policy from another.

Only the post and image levels can override this: a tag-level conflict is always settled in favour of privacy.

### Posts

```yaml
---
title: A day in the valley
date: 2025-07-12
tags: [hiking/alps]
location: coarse
camera: keep
---
```

### Images

To treat one image differently, list it in the post's `images` map. The key is the image's path as the post refers to it, and the value holds `location`, `camera` or both:

```yaml
---
title: A day in the valley
date: 2025-07-12
tags: [hiking/alps]
images:
  IMG_1043.jpg:
    location: strip
  photos/summit.heic:
    location: keep
    camera: keep
---
```

- The key matches the path written in the Markdown (`![...](IMG_1043.jpg)`), ignoring a leading `./`, the direction of the slashes and percent escapes (`my%20photo.jpg` matches `my photo.jpg`). Names are case sensitive.
- A key that is a bare file name (`IMG_1043.jpg`) also matches an image of that name in a sub-folder of the post. A key with a folder (`photos/summit.heic`) names exactly that image.
- An image can set only one of the two settings; the other one comes from the post, the tags or the site.
- A key that no image of the post uses is not an error, but its values are still checked.

The map is used rather than an attribute after the image (`![...](a.jpg){location=keep}`) because Markdown has no such syntax and every extension for it breaks in some other tool, such as the GitHub preview used when writing from a phone. Keeping the exceptions together in the front matter also makes them easy to review.

## What is checked

A value that the setting does not accept (`camera: coarse`, `location: Keep`, a misspelt `locaton` key inside an `images` entry) fails the build with the file and the key, rather than publishing the image with a policy the author did not intend:

```
journal/trip/index.md: images.IMG_1043.jpg.location: must be one of: strip, coarse, keep
```

Values of `tags.yaml` and the site configuration are checked for every entry, whether or not a post uses it.

## For people extending coffer

`createPolicyResolver({ site, tags, tagsFile })` in `src/images/policy.js` returns a function `(post, image) => policy`. The policy has two entries, `location` and `camera`, each `{ value, source }`, where `source` is `{ level, origin }`:

| `level`  | `origin`                                                                         |
| -------- | -------------------------------------------------------------------------------- |
| `site`   | `null`                                                                           |
| `tag`    | The path of the `tags.yaml` entry that carries the setting (an ancestor of the post's tag, or the tag itself). Where several tags give the strictest value, the first in the post's tag order. |
| `post`   | The path of the post's file.                                                     |
| `image`  | The key in the post's `images` map.                                              |

`describeSource(source)` turns a source into words for a report. The module reads no files and changes no images; the pipeline applies the decision.

## What the build does with the decision

The build resolves the policy of every image of every post, of the cover and of the home page, and gives it to the image pipeline, which applies it to the viewer JPEG (see [What the files carry](images.md#what-the-files-carry)). The WebP variants never carry metadata.

- A wrong value fails the build with the file and the key, as above. The images are then published without any metadata, so the other problems of the build are still reported.
- An entry of a post's `images` map that no image of the post uses is a warning: `journal/trip/index.md: images: "IMG_1043.jpg" matches no image of the post`. A misspelt file name would otherwise leave the image with the policy of the post.
- The build report lists the **posts that publish exact locations**, with the number of images in each whose published file carries the exact position (in `.coffer/report.json` as `exactLocations`), and `coffer build` prints the list after every build:

  ```
  Posts publishing exact locations (1)
    content/journal/mountain-weekend.md: 1 image(s)
  ```

  Without such a post it prints `Posts publishing exact locations: none`. Only images that really have a position count: a post with `location: keep` whose photos have none is not listed.
- The manifest records each image's policy and the coordinates it publishes, see [Images](images.md#the-manifest). `coffer check` reads the published files back and fails when they do not match, see [Checking a finished build](checks.md).
