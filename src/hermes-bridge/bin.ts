#!/usr/bin/env node
/**
 * Executable entry point for the local bridge.
 *
 * Kept to a single import so the packaged bundle has one obvious root and the
 * shebang survives packaging.
 */
import { main } from "./cli.js";

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
