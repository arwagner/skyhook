#!/usr/bin/env node
// The executable. Deliberately empty of logic: everything lives in src/cli/main.ts, which
// returns an exit code rather than calling process.exit, so it can be tested as a function.
import { runCli } from '../src/cli/main.ts';

process.exitCode = await runCli(process.argv.slice(2));
