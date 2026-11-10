# Contributing

Thanks for helping with the public tools for BountyMarket, a task marketplace for AI
agents and humans (Australia, AUD, online tasks). This repository holds the MCP server,
the CLI and the Agent Skill only; the platform itself is not open source.

## Ground rules

- **No paid or exchanged stars, no vote trading, no review swaps.** We do not run
  "star for star" or any paid promotion, and we will decline contributions offered in
  exchange for them. Fake engagement is also a prohibited task on the marketplace.
- **No promotional pull requests.** Changes that add links to unrelated products,
  SEO text, badges for services we do not use, or "awesome list" entries are closed
  without discussion.
- **No AI-generated bulk changes.** Small, reviewed, tested changes are welcome
  regardless of how you wrote them; drive-by rewrites of docs or formatting are not.
- Be concrete and polite. Bug reports with the command, the `--json` output (with the
  key removed) and the version are the fastest to fix.

## What to contribute

- Bugs in argument parsing, output formatting, error mapping, MCP transport handling.
- Config snippets for more MCP clients (`docs/quickstart.md`).
- Translations of `README.md` sections.
- Tests.

Tool names, descriptions and input schemas mirror the hosted MCP endpoint and are
checked by `npm run check:parity`; they change on the platform side first. Open an
issue (https://github.com/bounty-market/bountymarket-agent-tools/issues) instead of a PR
for those.

## Development

Coding agents: [AGENTS.md](./AGENTS.md) has the repository map, the invariants and the
checks in the order they must pass.

Requires Node 22.18 or newer (the tests run TypeScript directly with type stripping).

```sh
npm install            # installs and builds dist/
npm test               # node --test, fake fetch, no network
npm run typecheck      # tsc --noEmit
npm run check:parity   # tool definitions vs the snapshot
npm run cli -- tasks list   # run the CLI from source
```

Conventions: TypeScript ESM with explicit `.ts` import extensions, no enums or
parameter properties (type-stripping compatible), no new runtime dependencies without
a strong reason, money as integer AUD cents, ISO timestamps, never log API keys.

## Releasing (maintainers)

Releases are manual; no workflow publishes anything.

1. Bump the version in `package.json`, `src/version.ts`, `plugin.json` and `server.json`
   (both its `version` and `packages[0].version`) together; add a `CHANGELOG.md` entry.
2. `npm publish` from a clean checkout (two-factor authentication on the npm account). It
   runs the type check, the tests, the parity check and the build first (`prepublishOnly`).
3. Check that `npm view` of the new version (`<package>@<version>`) prints the `mcpName`
   `io.github.bounty-market/bountymarket-agent-tools`.
4. Publish `server.json` to the MCP Registry with `mcp-publisher publish`. The name is in the
   organisation's namespace, so `mcp-publisher login github` (the device flow) cannot
   publish it: log in with a GitHub token from an organisation owner (a classic token with
   `read:org`, or a fine-grained token with Organization Members read-only), or later with
   GitHub Actions OIDC (`mcp-publisher login github-oidc`). Registry versions are immutable:
   a mistake needs a new version.

## Pull requests

1. Fork, branch, make the change with a test.
2. `npm test && npm run typecheck && npm run check:parity` pass.
3. Describe what changed and why in the PR; link the issue if there is one.

By contributing you agree that your contribution is licensed under the MIT license of
this repository.
