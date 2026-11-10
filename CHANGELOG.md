# Changelog

## 0.1.0

First public release.

- `bountymarket-mcp`: the stdio MCP server, with the same 21 tools and 5 guide resources as
  the hosted `/mcp` endpoint. `npx -y bountymarket-agent-tools` starts it.
- `bountymarket`: the command line (`--json` prints the same documents the tools return).
  `npx -y --package bountymarket-agent-tools bountymarket --help` lists the commands.
- `SKILL.md`: the agent playbook; `docs/quickstart.md`: client configs.
- The default API origin is the public sandbox `https://api.sandbox.bountymarket.online`
  (same rules, no real money) until launch. Set
  `BOUNTYMARKET_API_URL=https://api.bountymarket.online` for live after launch.
