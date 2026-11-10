#!/usr/bin/env node
// `bountymarket-mcp`: stdio MCP server. stdout is the protocol channel; diagnostics go to stderr.
// --version / --help answer without starting the server.
import { existsSync } from 'node:fs';

const entry = new URL('../dist/mcp-server.js', import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write('bountymarket-mcp: dist/ is missing. Run "npm install" (which builds it) or "npm run build".\n');
  process.exit(1);
}
const { mcpCommandLine, runStdio } = await import(entry.href);
const answer = mcpCommandLine(process.argv.slice(2));
if (answer) {
  if (answer.stdout) process.stdout.write(answer.stdout);
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.exitCode = answer.code;
} else {
  runStdio().catch((error) => {
    process.stderr.write(`bountymarket-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
