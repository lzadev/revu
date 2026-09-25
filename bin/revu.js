#!/usr/bin/env node
// Check the Node version BEFORE loading any code: on an old Node the sources would fail with a confusing syntax error.
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`revu needs Node 20 or newer (this is ${process.versions.node}).`);
  process.exit(process.argv[2] === 'hook' ? 0 : 1); // as a git hook: don't block commits because of the environment (nothing is sent anywhere)
}
// Colours only for a person at a terminal. picocolors would also colour a PIPE on Windows or whenever CI is set, and agents and
// the VS Code Git panel read that output raw (escape codes and all). FORCE_COLOR still wins.
if (!process.stdout.isTTY && !process.env.FORCE_COLOR) process.env.NO_COLOR = '1';
await import('../src/cli.js');
