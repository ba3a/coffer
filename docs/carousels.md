# Carousels

A carousel shows several images of a post one at a time in the width of the text column. You swipe it on a phone, scroll it with the wheel or the keyboard, or, when scripts are on, use its buttons and the arrow keys. It never starts moving by itself and nothing in it is animated.

## Syntax

Write a container directive `:::carousel` around the images. Each image is an ordinary Markdown image: the text in the square brackets is its alt text, the optional quoted text after the address is its caption.

```markdown
:::carousel[Day two on the ridge]
![Mist in the valley below the camp.](mist.jpg "Six in the morning.")

![A dark ridge against an orange evening sky.](ridge.jpg "Just before the rain.")

![The tent, from inside.](tent.jpg)
:::
```

- The words in square brackets after `carousel` are the name of the carousel, which screen readers announce. Leave them out to get a generic name from the UI strings of the site (`carousel.label`, "Image carousel" in English).
- The images may be one per paragraph (or on consecutive lines), or a Markdown list:

  ```markdown
  :::carousel
  - ![Mist in the valley below the camp.](mist.jpg "Six in the morning.")
  - ![The tent, from inside.](tent.jpg)
  :::
  ```

- Give every image alt text; the build warns about an image without it, as it does everywhere else.
- A caption is optional. A slide without one has no `<figcaption>`.
- The images are found, resized and checked exactly like images in the text (see [Images](images.md)), and the metadata policy of the post applies to them (see [Location and camera metadata](location-policy.md)).
- A carousel holds nothing but images. Text, code, headings, a nested carousel and attributes such as `{.wide}` are errors, as is a carousel with no image; the message names the file and the line.

A carousel of one image works but needs no controls; use a plain image instead.

## What it becomes

```html
<section class="carousel" aria-label="Day two on the ridge" data-carousel
         data-label-previous="Previous image" data-label-next="Next image">
  <ul class="carousel-track" tabindex="0">
    <li class="carousel-slide">
      <figure>
        <picture>...</picture>
        <figcaption>Six in the morning.</figcaption>
      </figure>
    </li>
    ...
  </ul>
</section>
```

- The named `<section>` is a landmark region. The names of the buttons are on it because the script that adds the buttons cannot know the language of the site.
- Each slide is a `<figure>` with a `<picture>` and an optional `<figcaption>`, as for an image on its own.
- `width` and `height` are set on every `<img>`, so the page does not jump while the images load.
- The `sizes` attribute is [`images.carouselSizes`](configuration.md#images). It defaults to the width of the text column, because a slide is as wide as the carousel. Change it for a theme where carousels are wider or narrower than the text.
- The first slide loads at once when the carousel starts the page, and the other slides are lazy (`loading="lazy"`), so a long carousel costs one image until you look at the next. Slides follow the rule of every image of a page, that only the first image of the page is eager: a carousel that comes after another image is lazy from its first slide, and is loaded when it nears the screen.

## Without a script

The list is a flex row with `overflow-x: auto` and `scroll-snap-type: x mandatory`, and each slide is as wide as the list and snaps into place. That is all a browser needs to make the carousel:

- swipeable on a touch screen,
- scrollable with the wheel, the trackpad or the scrollbar,
- reachable with the keyboard (the list can take the focus, and the arrow keys scroll it),
- printable: on paper all slides are printed one under the other.

Every slide is in the page, so search engines, feed readers and assistive technology see all of them. Feeds carry the images as plain figures (see [Feeds](feeds.md)).

## With a script

Pages with a carousel load `assets/carousel.js` (plain JavaScript, `defer`, no libraries). For each carousel of two or more slides it adds under the list:

- **Previous** and **Next** buttons, named from the UI strings `carousel.previous` and `carousel.next`. At the ends a button is marked `aria-disabled` and keeps the focus.
- A position indicator such as `2 / 7`, which a screen reader announces politely when it changes.
- The keys **Left** and **Right** arrow, **Home** and **End** while the focus is in the carousel. Keys pressed with Alt, Ctrl, Shift or Meta are left to the browser.

A slide is shown by jumping to it (`behavior: 'instant'`), also where a style sheet asks for smooth scrolling. The indicator follows swiping and scrolling by hand. There is no autoplay and there are no timers.

The script has no special handling of right-to-left layouts: the arrow keys mean previous and next in the order of the list, left to right.

## The image viewer

The images of a carousel are images of the post, in document order: a carousel in the middle of a post is walked through between the image before it and the image after it. `renderMarkdown` returns the list as `images` (see [Markdown](markdown.md#result)), with `carousel: true` for slides. Clicking a slide opens the fullscreen viewer on that image and the viewer walks on through the rest of the post (see [The image viewer](viewer.md)); without scripts a slide links to its full-size file.

## Styling

The default stylesheet styles `.carousel`, `.carousel-track`, `.carousel-slide`, `.carousel-controls`, `.carousel-button` and `.carousel-position` with the custom properties of the theme (see [Themes](themes.md)). A site theme replaces the script by putting its own `carousel.js` in its `assets/` folder.
