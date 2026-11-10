#!/usr/bin/env node
// `bountymarket` command line. Runs the compiled dist/ (built by `npm install` / `npm run build`).
import { existsSync } from 'node:fs';

// A reader that closes early (`bountymarket capabilities --json | head -2`) ends the output quietly instead of an EPIPE stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

const entry = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write('bountymarket: dist/ is missing. Run "npm install" (which builds it) or "npm run build".\n');
  process.exit(1);
}
const { run } = await import(entry.href);
const code = await run(process.argv.slice(2), {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  env: process.env,
});
process.exitCode = code;
