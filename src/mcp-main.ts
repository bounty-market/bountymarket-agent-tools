import { MCP_BIN } from './brand.ts';
import { mcpCommandLine, runStdio } from './mcp-server.ts';

// --version / --help answer without starting the server; any other argument is refused (exit 2).
const answer = mcpCommandLine(process.argv.slice(2));
if (answer) {
  if (answer.stdout) process.stdout.write(answer.stdout);
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.exitCode = answer.code;
} else {
  runStdio().catch((error: unknown) => {
    process.stderr.write(`${MCP_BIN}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
