# Sample tool

This folder is a fixture for the coffer example site, not a real project. It
stands in for the repository of the example tool "Kerfcalc": a made-up
README, a few guides in `docs/`, a changelog, a licence and one source file.

The site configuration reads it in place (`docs.source.path`), and the tests
copy it into a temporary git repository to exercise the git sources.

- [Getting started](docs/getting-started.md)
- [Usage](docs/usage.md)
- [Changelog](CHANGELOG.md)

## Quick start

Work out how much of a board the blade turns into dust:

```sh
kerfcalc waste --board 2400 --kerf 2.4 --pieces 600,450,450,300
```

Every option is described in the [usage guide](docs/usage.md#options), and the
[changelog](CHANGELOG.md) lists what changed between versions.

## Licence

MIT, see [LICENSE](LICENSE).
