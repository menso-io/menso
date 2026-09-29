#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`menso: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
