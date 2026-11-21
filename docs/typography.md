# Typography

coffer sets the typography of your texts at build time, by the rules of the language of each text. You write plain Markdown: `"quotes"`, `--`, `...`. The source files are never changed. Only the built pages are.

Typography is on by default. Old posts are fixed by the next build, with no migration step. The same input and settings always give the same output.

## What changes per language

Five languages have their own rules: `en`, `ru`, `de`, `fr` and `hy`. Every other language uses a neutral set: curly quotes, en and em dashes, the ellipsis character, no language-specific spaces and no change of heading case. A regional tag such as `fr-CH` uses the rules of `fr`.

| Language | Quotes (outer, inner) | Sentence dash | Notes |
| -------- | --------------------- | ------------- | ----- |
| `en` | `“ ”`, `‘ ’` | `—`, unspaced | Title Case headings. Set `dashStyle: spaced-en` for ` – `. |
| `ru` | `« »`, `„ “` | ` — `, with a no-break space before it and a normal space after | Prepositions and short words stay with the next word. Sentence case headings. |
| `de` | `„ “`, `‚ ‘` | ` – `, spaced en dash | Only the first letter of a heading is raised. |
| `fr` | `« »`, `“ ”` | ` — `, spaced em dash | Narrow no-break space before `;` `!` `?` and inside `« »`; no-break space before `:`. Sentence case headings. |
| `hy` | `« »`, `“ ”` | ` — `, spaced em dash | Experimental, see below. |
| other | `“ ”`, `‘ ’` | `—` | Neutral set. |

These rules apply to all languages:

- An apostrophe inside a word, or before digits (`'90s`), becomes `’`.
- `---` is an em dash, `--` is an en dash, and ` - ` (a hyphen with a space on both sides) is the sentence dash of the language. A hyphen between numbers (`1-5`) becomes an en dash. A hyphen inside a word never changes. A minus before a digit (`-5`) is the minus sign `−`.
- `...` becomes `…`.
- `x` between two numbers (`4x6`) becomes `×`.
- A no-break space joins a number and its unit, the digits of a long number, and `§`, `№` or `#` and the number after it.
- Marks the author already typeset (`«`, `„`, `“`) stay as they are. No-break spaces that the author wrote stay too.

Quotes are paired by position inside one block, across inline markup: `"a *b* c"` is one quote. An unpaired quote stays as typed and the build reports a warning with the file and line.

### Armenian is experimental

The `hy` rules have not been reviewed by a native reader. Quote marks, the spaced em dash and the full stop `։` may change after review. At the end of a sentence, `.` or `:` after an Armenian letter becomes `։`. Nothing else is changed: `,`, `?` and `!` stay as typed. To turn the `hy` rules off, set `typography.locale` to a language without rules, such as `und`, or turn typography off.

## Language and locale

The language of the text sets the typography locale. There are three levels, and the nearest wins: the post, the blog, the site.

| Level | Where | Keys |
| ----- | ----- | ---- |
| site | `coffer.yaml`, the site | `lang`, `typography` |
| blog | `coffer.yaml`, an entry of `blogs` | `lang`, `typography` |
| post | front matter | `lang`, `typography` |

`lang` is a BCP 47 tag. It is optional at the blog and post level and inherits from the level above. The site `lang` defaults to `en`. A post or blog `lang` sets the `lang` attribute of the post's `<article>` when it differs from the page. Interface strings and dates keep using the site `lang`.

`typography.locale` overrides the typography locale only, for a text whose rules differ from its language.

## Settings

```yaml
typography:
  enabled: true          # false turns everything off
  locale: ru             # optional: override the typography locale
  hanging: true          # hanging punctuation
  headings: locale       # locale | keep
  widows: true           # keep the last two words together
  feeds: true            # also typeset feed titles and summaries
  dashStyle: locale      # en only: locale (unspaced em dash) | spaced-en
  keep: [coffer, iPhone, npm]   # words that heading case never changes
```

A lower level merges into the higher one key by key, and `keep` lists are joined. In post front matter, `typography: false` is short for `typography: { enabled: false }`. A mistake in the settings fails the build with the key path, like the rest of the configuration.

There is no switch for each rule. Use `enabled`, the escapes below, or `data-typography="off"`.

### Widows

With `widows: true`, the last two words of a paragraph, list item or heading are joined by a no-break space, so a line does not end with one short word. This is skipped when the block has fewer than three words or the last word is longer than 12 characters.

## Opt-out and escapes

- Set `typography: { enabled: false }` for a site or a blog, or `typography: false` in the front matter of a post.
- A Markdown backslash keeps a character as typed: `\"` stays a straight quote, `\--` stays two hyphens, `\...` stays three dots.
- `:verbatim[text]` leaves a span as typed. `:::verbatim` does the same for a block:

```markdown
The flag is :verbatim[--no-color], and "this" is typeset.

:::verbatim
"This" block stays exactly as written -- all of it.
:::
```

- Any element with `data-typography="off"` in raw HTML is left as written, with its content.

## Heading case

Heading case applies to headings, post and page titles, and table of contents entries. It follows the convention of the language:

| Language | Rule |
| -------- | ---- |
| `en` | Title Case: the first and last word, the word after a colon, and every word that is not a small word (`a`, `the`, `of`, `to`, `with` and similar) start with a capital letter. |
| `ru`, `fr`, `hy` | Sentence case: a heading that is in title case (three or more words, all capitalised) is lowercased after the first word. Other headings stay as written. |
| `de`, neutral | As written, except the first letter is capitalised in `de`. |

Words with an inner capital (`iPhone`), words with digits, all-caps words, and words with `.`, `_`, `/` or `@` never change. Inline code is never changed. Lowercase names such as `coffer` or `npm` are capitalised by the `en` rule unless you list them in `keep`. The build report lists each heading it changed, so a missing `keep` entry is easy to find.

`headings: keep` turns heading case off. Heading `id`s come from the source text, so existing links keep working.

## Hanging punctuation

An opening quote, bracket or sentence dash at the start of a paragraph, heading, list item or quote hangs into the margin, so the text lines up. The build wraps the mark in `<span class="hang" data-m="quote">`. The default theme styles it, and uses `hanging-punctuation: first` where the browser supports it. See [Themes](themes.md#hanging-punctuation). `hanging: false` turns it off.

## Where it applies

| Text | Typeset |
| ---- | ------- |
| Post and page bodies, guides, project pages, the home page, README sections | yes |
| Headings, titles and table of contents entries | yes |
| `<title>`, meta description, Open Graph and share text | yes, as plain text: normal spaces and no `hang` spans |
| Feeds | entries reuse the page HTML without `hang` spans; titles and summaries are plain text. `feeds: false` leaves titles and summaries as written. See [Feeds](feeds.md). |
| Search | folded, see below |

The engine never changes:

- `code`, `pre`, `kbd`, `samp`, `script`, `style` and `textarea`;
- attributes of any kind, image alt text and captions;
- raw HTML written by the author;
- bare URLs and email addresses in text;
- front matter values other than the title and the summary.

## Search

The search index and the query are folded to one form: all quotes become `"` and `'`, all dashes become `-`, `…` becomes `...`, no-break spaces become spaces and `։` becomes `.`. A reader who types `don't` finds `don’t`. See [Search](full-text-search.md).

## Rebuilds

`build-info.json` has a `typographyRulesVersion` field. A new version of the rules makes `coffer rebuild-needed` answer `yes`, so every text is set again. See [Scheduled rebuilds](scheduling.md).
