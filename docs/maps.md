# Maps and GPX tracks

A post can publish the GPX tracks of a walk, ride or climb. Drop the `.gpx` files next to the post; the build reads them, publishes each file for download, computes a summary and writes the simplified geometry that the map draws. The tracks and the photos with a published position together make the map of the post, which is described [below](#the-map).

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

## The map

A post gets a map when it has at least one track or at least one image with a published position (the [location policy](location-policy.md) is `keep` or `coarse` for it). A post with neither gets no map at all, and its page loads no map code. A photo whose policy is `strip` has no position to show, so a post with only such photos has no map. Only the images that the [viewer](viewer.md) opens count: an image that is already inside a link of its own does not.

The map shows:

- the tracks, as lines (OpenStreetMap tiles underneath, with the credit that their licence asks for in the corner of the map);
- one marker for every place where photos were taken, at the position the published file carries, so a `coarse` photo is at its rounded position (about a kilometre off) and never at the exact one. Photos published at the same point share one marker, with their number on it, so none hides another;
- under the map, for every track: its title, the distance, the climb and the highest point (a file without elevations has neither of the last two), and a link **Download GPX**.

A click on a marker opens its first photo in the fullscreen viewer, which walks on through the other images of the post. In the viewer, the button **Show on map** (for images with a published position) closes the viewer, scrolls to the map, centres it on the photo's marker and opens the marker's name. With several maps on a page the one that shows the photo answers.

On a blog index, tag page or series page that shows whole posts (setting `index`, see [Configuration](configuration.md)), each post brings its own maps, and each map works on its own: it shows its post's tracks and photos only. Leaflet, the map script and the map styles are included once per page. The markers point at the images of the page's one viewer, so a click opens the right photo (see [The image viewer](viewer.md#on-list-pages-of-full-blogs)), and **Show on map** answers on the map that shows the photo. Map markup has no `id` attributes, so nothing clashes between posts.

The mouse wheel zooms a map only while the map has the keyboard focus, so scrolling the page past a map does not zoom it. A marker can be reached with the keyboard (Tab) and opened with Enter. Nothing is animated: the script turns off Leaflet's zoom, fade, marker and inertia animations, and `map.css` switches its remaining transitions off.

### Without JavaScript

The map area is not empty without scripts. The build draws the tracks and the photo points as an SVG, projected to the box around them (north is up, east is to the right, and the east-west scale is corrected for the latitude), in the same frame the interactive map takes over, so the page does not jump when the script starts. There is no map underneath it: it is a sketch of the route, not a replacement for the tiles. The summary, the download links and the photo points (each a link to the full-size photo) work as they do with scripts. The script hides the drawing when Leaflet starts; if Leaflet cannot be loaded the drawing stays.

### Where the map goes

By default the map is at the end of the post, after the last paragraph. To put it somewhere else, write a `::map` leaf directive on a line of its own:

```markdown
The climb starts at the hut.

::map

Then the ridge, which is the part I liked best.
```

A post with a `::map` directive has the map there and no map at the end. To show only some of the tracks or photos, or to have several maps, give the directive attributes. Both attributes are optional and take `all` (the default), `none` or a comma-separated list of names:

| Attribute | Names                                                                                | Example                         |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| `tracks`  | The file names of tracks of the post, with or without `.gpx`.                        | `tracks="day-one.gpx"`          |
| `photos`  | Images of the post, by the address as written in the text or by the file name alone. | `photos="summit.jpg,hut.jpg"`   |

```markdown
::map{tracks="day-one" photos="none"}

...

::map{tracks="day-two" photos="day-two-hut.jpg,day-two-summit.jpg"}
```

- A name that matches no track of the post, or no image of the post at all, is an error that names the file and the line. An image that exists but publishes no position is not a mistake; it simply has no marker.
- A directive that ends up with nothing to show (for example `::map{tracks="none" photos="none"}`, or photos that all have the policy `strip`) leaves no map and gives a warning. A `::map` directive outside a post (for example in `home.md`) shows nothing, because only posts have tracks and located photos; it is removed with a warning.
- Any other attribute, an attribute without a value, or text in square brackets is an error.
- A track named `all` or `none` cannot be chosen by name; rename the file.

### Switching the map off

`map: false` in the front matter suppresses every map of the post, `::map` directives included (they are removed silently). The tracks stay published for download. `map: true` changes nothing: a map is never made from nothing.

### Feeds

A feed reader cannot run scripts, so the feeds carry the text of a post without its map. The GPX files are still published next to the post.

### The tiles

The default tile server is OpenStreetMap's own, `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, which needs no key. Its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) is meant for a personal site; heavy traffic should use another provider. A site can name another server, and the credit that goes with it, in [`map`](configuration.md#map):

```yaml
map:
  tileUrl: https://tiles.example/{z}/{x}/{y}.png
  attribution: Tiles by <a href="https://tiles.example">Example</a>
```

### How it is made

- The page loads Leaflet 1.9.4 (BSD 2-Clause, vendored in `theme/assets/vendor/leaflet/` with its licence; nothing comes from a CDN) and `assets/map.js`, after the viewer's scripts, and the style sheets `vendor/leaflet/leaflet.css` and `assets/map.css`. The markers are drawn with CSS, so none of Leaflet's marker pictures are needed.
- Every map is an element `<div class="coffer-map" data-map>` that holds the drawing, the summary and a `<script type="application/json" class="map-data">` with the data of the map: the tiles, the words, the box, the tracks (the address of each simplified `.geojson` file, which the script fetches) and the markers (position, whether it is `exact` or `coarse`, the places of its photos in the viewer's list of images, and a name taken from the alt text, else the caption, else "Photo n").
- A click on a marker clicks the link of its photo (`a[data-viewer]`), which is what the viewer script listens to. The viewer's button fires the event `coffer:show-on-map` (see [The image viewer](viewer.md#show-on-map)), which `map.js` answers.
- The markup comes from the template `map.njk`, which a theme can replace; `map.js` and `map.css` can be replaced the same way (see [Themes](themes.md)).
- The manifest lists the maps of each post under `maps`: the GPX addresses of the tracks, the number of photos and the markers with their published positions, so that a check can compare them with the policy.
