# Getting started

Kerfcalc is a command-line calculator for saw kerf. This page is part of a
fixture: the tool does not exist.

![A board with a thin cut](board.png)

Run the first calculation:

```sh
kerfcalc waste --board 2400 --kerf 2.4 --pieces 600,450,450,300
```

Next, read [Usage](usage.md) for every command, or jump to
[the options](usage.md#options). The calculation itself lives in
[Sample.kt](../src/main/kotlin/Sample.kt), all the sources are in the
[src folder](../src/), and the history of the tool is in the
[changelog](../CHANGELOG.md).
