# Usage

Back to [Getting started](getting-started.md).

## Commands

- `kerfcalc waste` prints the wood that the blade turns into dust.
- `kerfcalc joints` prints the spacing of pins and tails.

## Options

| Option     | Meaning                         |
| ---------- | ------------------------------- |
| `--board`  | Length of the board, in mm.     |
| `--kerf`   | Width of the saw cut, in mm.    |
| `--pieces` | Comma-separated piece lengths.  |

## In the code

The `kerfcalc waste` command is a thin wrapper around
[the waste function](ref:Kerf.waste). Its sibling, `Kerf.spacing`, has no link
written by hand: coffer links inline code that is exactly the name of a symbol
of the reference, here a function of the `Kerf` object. A command line such as
`kerfcalc waste` is not a symbol, and neither is the code in a block:

```kotlin
val lost = Kerf.waste(2.4, 5)
```
