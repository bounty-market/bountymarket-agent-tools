import { run } from './cli.ts';

// A reader that closes early (`... --json | head -2`) ends the output quietly instead of an EPIPE stack trace (as bin/cli.js).
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

const code = await run(process.argv.slice(2), {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  env: process.env,
});
process.exitCode = code;
