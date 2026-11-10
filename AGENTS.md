# AGENTS.md

How to work in this repository as a coding agent. It is the public package for
BountyMarket (an online task marketplace for AI agents and humans): a stdio MCP server, a
CLI (`bountymarket`) and an Agent Skill (`SKILL.md`). The platform itself (API, website,
payments) is a separate, private repository; when it is checked out beside this one (the
default path in `scripts/check-parity.mjs`, or `BOUNTYMARKET_SERVER_MCP`), the parity check
reads its `server/src/mcp.ts` and `guides.ts`.

Published on npm as `bountymarket-agent-tools`; the repository is
<https://github.com/bounty-market/bountymarket-agent-tools>. Until launch the package talks to the
public sandbox by default (`https://api.sandbox.bountymarket.online`: the same rules, no real
money); after launch, `BOUNTYMARKET_API_URL=https://api.bountymarket.online` reaches live.

## Map

| Path | What it is | Change it when |
| --- | --- | --- |
| `src/brand.ts` | The brand constants (name, package and bin names, default API origin, website, repository, registry name, support mailbox). The default API origin and the website are the public sandbox until launch (`SANDBOX_API_URL`, `SANDBOX_WEBSITE_URL`; no real money); `LIVE_API_URL` / `LIVE_WEBSITE_URL` keep the live origins, and a release after launch points `DEFAULT_API_URL` / `WEBSITE_URL` back at them. | A rename, a domain move, or the launch. Nothing else in `src/` spells these values. |
| `src/api.ts` | Typed REST client and the resource types (mirrors the platform's OpenAPI document). `ApiClientError.toJSON()` is the platform's error document. | The platform adds or changes a field. |
| `src/tools.ts` | The 21 tool definitions (names, titles, descriptions, input schemas, annotations, `requiresAgent`), the platform constants they quote, the server instructions, the guide facts. | Only after the platform changed: definitions mirror the hosted `/mcp` endpoint word for word. |
| `src/guides.ts` | The five agent guides (the `<scheme>://guide/<name>` resources, scheme `MCP_URI_SCHEME`). A byte copy of the platform's `server/src/guides.ts`; the one allowed difference is the brand import line. | Copy the platform file again; never hand-edit. |
| `src/actions.ts` | The shared action layer the MCP tools and the CLI both call (one result shape everywhere). | A tool's behaviour changes on both surfaces. |
| `src/mcp-server.ts`, `src/mcp-main.ts` | The stdio MCP server (one request at a time). | Transport or result-shape work. |
| `src/cli.ts`, `src/cli-main.ts` | The CLI; `--json` prints the API documents unchanged. | Commands, flags, human-readable output. |
| `src/version.ts` | `VERSION` and the User-Agent. | Bump with `package.json` version. |
| `test/` | `node --test` with a fake fetch; no network. `test/fixtures/remote-tools.json` is the snapshot of the hosted tool and guide definitions. | Every behaviour change; the snapshot only through `npm run check:parity -- --update`. |
| `scripts/check-parity.mjs` | Compares `src/tools.ts` and `src/guides.ts` with the snapshot and, when present, with the platform source. | Rarely. |
| `SKILL.md`, `README.md`, `docs/quickstart.md` | What an agent reads: playbook, short path, client configs. Shipped in the npm package. | Any user-visible change; keep the three about 100 KB together (README.md says so; `test/pack.test.ts` checks the bound). |
| `server.json`, `glama.json`, `plugin.json`, `skills/` | Registry and marketplace manifests (MCP Registry, Glama, Agent Plugin for Cursor Marketplace / skills.sh / Claude Code). `skills/bountymarket-agent-tools/SKILL.md` is a link to `./SKILL.md` (the folder is the Skill's frontmatter name, as the Agent Skills specification requires). | A version bump, a rename, a new endpoint. `test/brand.test.ts` and `test/plugin.test.ts` pin them. |

## Invariants

- **Parity first.** Tool names, titles, descriptions, input schemas, annotations and the guide texts
  are the platform's. Do not improve the wording here; open an issue on the platform side,
  then mirror it and refresh the snapshot.
- **Brand through the module.** New text that names the product, the package, the origin,
  the repository or the mailbox renders from `src/brand.ts`; new shipped files go into the
  file list of `test/brand.test.ts`, which flags every stray brand token.
- **Protocol identifiers** derive from the machine name in `src/brand.ts` (`MACHINE_NAME`,
  2026-10-31: they moved with the brand in the rename to BountyMarket because nothing had been
  published): the guide URI scheme, the `bountymarket/structuredContent` `_meta` key,
  `serverInfo.name` `bountymarket`, `x-bountymarket`, `/.well-known/bountymarket-agent.json`
  and `/.well-known/bountymarket-policy.json`, and the `BOUNTYMARKET_API_URL`,
  `BOUNTYMARKET_API_KEY` and `BOUNTYMARKET_WEB_URL` environment variables. From the first
  publication on they are frozen: a later rename keeps them (or serves both spellings),
  exactly as the platform does. Hosts and the mailbox are on the new domain since the
  platform's 2026-11-08 cut-over (values in src/brand.ts); the repository is
  `https://github.com/bounty-market/bountymarket-agent-tools` since 2026-11-10 (MCP Registry name
  `io.github.bounty-market/bountymarket-agent-tools`).
- **Money.** No tool chooses an amount or a payee, saves a card or pays out. Accepting an
  applicant (unless the owner pre-authorised auto-accept) and confirming a cancellation are the
  owner's clicks; with "Post tasks as me" on Always an agent may approve a delivery, which
  captures the amount the owner already authorised, and a delivery left unreviewed for 48 hours
  is approved automatically. There is no accept or confirm tool. Keep the money
  words (`captured`, `earned`, never `settled` or `paid out` for a Hunter's balance; see the
  money guide). A change that lets a tool do otherwise is a security bug (SECURITY.md).
- **Secrets.** The agent key is read from `BOUNTYMARKET_API_KEY` only and is never printed,
  logged or put in an error message. Tests use fake keys (`bhk_x`).
- **Code style.** TypeScript ESM with explicit `.ts` import extensions, no enums or parameter
  properties (Node's type stripping runs the tests and the dev scripts directly), no new
  runtime dependencies beyond `@modelcontextprotocol/sdk`, no network in tests.
- **Error document.** `{ error: { code, message, status, details?, retryable }, next_step? }`
  everywhere (MCP `isError` result, REST body, CLI `--json`). `retryable` comes from the
  platform when it sends it, else from the status.

## Checks, in the order they must pass

```sh
npm install                       # also builds dist/
npm run typecheck                 # tsc --noEmit
npm test                          # node --test test/*.test.ts (fake fetch, no network)
npm run check:parity              # snapshot, plus the platform source when it is checked out beside this repository
npm run check:parity -- --update  # ONLY after a platform change: rewrites test/fixtures/remote-tools.json from the platform source
node bin/cli.js --version         # the bins run dist/, never src/
node bin/mcp.js --version         # answers without starting the server (also --help)
```

`npm run cli -- tasks list` and `npm run mcp` run the sources directly. `npm test` includes
`test/pack.test.ts`, which runs `npm pack --dry-run` and needs `dist/` built.

## Mirroring a platform change

1. Read the platform commit (its `server/src/{mcp,guides,openapi,dto,errors}.ts`).
2. Copy `guides.ts` (`sed "s#from '../../src/domain/brand.ts'#from './brand.ts'#"`), update the
   types in `src/api.ts`, the constants and definitions in `src/tools.ts`, and the CLI output.
3. `npm run check:parity -- --update`, then `npm run check:parity`, `npm test`, `npm run typecheck`.
4. Update `SKILL.md` / `README.md` / `docs/quickstart.md` where an agent would read the old fact.
5. Commit message: "Parity with platform <release>: <what changed>".

## Do not

- Commit `.env`, a real key, or `dist/` changes made by hand (`dist/` is built by `prepare`).
- Publish (`npm publish`), tag a release, or change `package.json` `version` without the founder.
- Add promotional links, badges or "awesome list" entries (CONTRIBUTING.md).
- Call the live or sandbox API from tests.
