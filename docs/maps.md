# Maps and GPX tracks

A post can publish the GPX tracks of a walk, ride or climb. Drop the `.gpx` files next to the post; the build reads them, publishes each file for download, computes a summary and writes the simplified geometry that the map draws. This page describes the tracks. How the map itself looks is described with the map in a later release of these docs.

## Adding a track

Put the GPX files in the post's folder (`{blog}/{slug}/`, the post being `index.md`):

```
journal/ridge-walk/
  index.md
  ridge-loop.gpx
```

Every `*.gpx` file in a post folder is a track of that post, in name order. To choose the files, set their order or give them titles, list them in the front matter:

```yaml
tracks:
  - { file: day-two.gpx, title: Day two, up to the ridge }
  - day-one.gpx
```

- A list entry is a file name beside the post, or a mapping with `file` and an optional `title`. Folders are not allowed.
- With a `tracks:` list only the listed files are tracks, in the order given. `tracks: []` publishes none, even when GPX files are there.
- A single-file post (`{slug}.md`) has no folder of its own, so only the files it lists are tracks; they are looked up beside the post file.
- Without a title, a track is called by the name inside the file (the `<name>` of the first track, else of the `<metadata>`), else by the file name without `.gpx`.

## What the build does

For each track the build writes, next to the post's page:

| File                       | Content                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `{post}/{name}.gpx`        | The GPX file exactly as it is on disk, for download.                                                     |
| `{post}/{name}.geojson`    | The track simplified for display, as a GeoJSON `FeatureCollection` of `MultiLineString`s with `[lon, lat, elevation]` positions. |

The summary is stored in the build manifest under the post's `tracks`: the title, the addresses of both files, the length (`distanceMeters`), the total climb (`elevationGainMeters`), the highest point (`highest`, with its elevation and position), the number of recorded and drawn points and the bounding box.

GPX files are read with the engine's own strict XML reader, so no extra dependency is needed. Tracks (`trk`, each with its segments `trkseg`) and routes (`rte`) are read; waypoints and timestamps are ignored.

### Distance

The length is the sum of the great-circle distances (haversine formula, Earth radius 6371008.8 m) between consecutive recorded points of each segment. The gap between two segments is not counted. Elevation is not part of the distance.

### Elevation gain

Recorded elevations jitter by a few metres even when standing still, so adding every small rise would overstate the climb. The gain counts a climb only once the elevation has risen by at least `elevationThreshold` metres (default 3) above a reference level, and moves the reference level down only after a fall of at least that much. A file without elevations has no gain and no highest point.

### Highest point

The point with the greatest recorded elevation (the first one when several are equal), with its position.

### Simplification

The drawn geometry is simplified with the Douglas-Peucker algorithm: points are dropped as long as the line through the kept points stays within `tolerance` metres (default 10) of every dropped one. The first and last point of every segment are always kept. Positions are rounded to 5 decimal places (about a metre). The summary is computed from every recorded point, not from the simplified line.

Both numbers are site settings, see [`tracks`](configuration.md#tracks).

## Invalid files

A file that is not well-formed XML, is not a GPX file, has a point without a numeric `lat` and `lon` in range, has a non-numeric `<ele>`, or has no track with at least two points fails the build. The error names the file:

```
content/journal/ridge-walk/broken.gpx <trkpt> at line 42: lat "x" is not a number
```

A file named in `tracks:` that does not exist fails the build in the same way. All broken files are reported together.

## Exact locations

A GPX file carries the exact positions of the track by nature: there is no coarse version of it. Publishing a track is therefore an explicit act, and it is not covered by the [location policy](location-policy.md) of images. Every post that publishes a track is listed in the build's "Posts publishing exact locations" section (printed after each build and stored in `report.json`), with its number of tracks beside its number of images:

```
Posts publishing exact locations (2)
  content/journal/mountain-weekend.md: 1 image(s)
  content/journal/ridge-walk/index.md: 1 track(s)
```

To keep a recording private, leave the GPX file out of the post's folder, or list the files to publish in `tracks:`.
