#!/usr/bin/env node
import { run } from '../src/cli.js';

const code = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
process.exitCode = code;
