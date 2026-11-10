/**
 * The brand, in one place (2026-10-30; renamed 2026-10-31, platform 2026-10-31.1:
 * the product is BountyMarket, the company stays XYPLATFORM, the vocabulary Setter / Hunter /
 * bounty is unchanged). Mirror of the platform's src/domain/brand.ts for this public package,
 * which cannot import the platform repository: the display name, the machine name and every
 * identifier derived from it, the npm package and bin names and the API origin are spelled out
 * here and nowhere else in src/. test/brand.test.ts pins package.json, server.json, plugin.json,
 * the bins, .env.example, the Dockerfile and the shipped docs (README.md, SKILL.md,
 * docs/quickstart.md) to these values, so a rename or a domain move is one edit here plus
 * whatever that test then points at. `npm run check:parity` compares the texts built from these
 * values word for word with the platform.
 *
 * Protocol identifiers live here too since the rename: nothing had been published yet, so the
 * machine name moved with the brand in one step, exactly as on the platform. From the first
 * publication on they are frozen again: the well-known paths, the OpenAPI extension, the MCP
 * _meta key, serverInfo.name, the guide URI scheme and the BOUNTYMARKET_* environment
 * variables. A later rename keeps them (or serves both spellings), exactly as the platform does.
 *
 * Hosts and the mailbox below are on the domain bountymarket.online since the platform's
 * cut-over of 2026-11-08. The public repository is github.com/bounty-market/bountymarket-agent-tools
 * (the company GitHub organisation, 2026-11-10), so the MCP Registry namespace is
 * io.github.bounty-market.
 *
 * Until launch the live origin does not answer, so the default API origin and the website the
 * owner is sent to are the public sandbox (same rules, Stripe test mode, no real money). The
 * live origins stay exported (LIVE_API_URL, LIVE_WEBSITE_URL); a release after launch switches
 * DEFAULT_API_URL and WEBSITE_URL back to them.
 */

/** Display name, as rendered in the CLI banner, the MCP serverInfo.title and the instructions. */
export const BRAND_NAME = 'BountyMarket';

/**
 * Public contact mailbox (the platform's SUPPORT_EMAIL / legal.json CONTACT_EMAIL): SECURITY.md
 * and the plugin.json author name it.
 */
export const SUPPORT_EMAIL = 'hello@bountymarket.online';

/**
 * The machine form of the brand: one lowercase word. It is the MCP serverInfo.name, the key of
 * the `mcpServers` entry in every copy-paste snippet, the guide URI scheme, the stem of the
 * well-known file names, of the OpenAPI extension and of the package and bin names (the
 * skills/<package name>/ directory plugin.json bundles is named after the Skill, PACKAGE_NAME).
 */
export const MACHINE_NAME = 'bountymarket';

/** URI scheme of the MCP guide resources (`bountymarket://guide/<name>`). */
export const MCP_URI_SCHEME = MACHINE_NAME;

/** `serverInfo.name` of the stdio server (mcp-server.ts), the same as the hosted endpoint's. */
export const MCP_SERVER_NAME = MACHINE_NAME;

/** The per-call `params._meta` opt-in that adds structuredContent next to the JSON text (tools.ts re-exports it). */
export const STRUCTURED_CONTENT_META_KEY = `${MACHINE_NAME}/structuredContent`;

/** The agent manifest and the machine-readable policy document the platform serves (api.ts manifest / policy). */
export const WELL_KNOWN_MANIFEST_PATH = `/.well-known/${MACHINE_NAME}-agent.json`;
export const WELL_KNOWN_POLICY_PATH = `/.well-known/${MACHINE_NAME}-policy.json`;

/** The OpenAPI vendor extension that carries the error catalog, the event facts and the discovery links (guides.ts). */
export const OPENAPI_EXTENSION = `x-${MACHINE_NAME}`;

/** Environment variables this package reads (api.ts configFromEnv; .env.example, the Dockerfile and the docs spell them). */
export const ENV_PREFIX = 'BOUNTYMARKET';
export const ENV_API_URL = `${ENV_PREFIX}_API_URL`;
export const ENV_API_KEY = `${ENV_PREFIX}_API_KEY`;
export const ENV_WEB_URL = `${ENV_PREFIX}_WEB_URL`;

/** npm name of this package (package.json name, server.json packages[].identifier, the User-Agent). */
export const PACKAGE_NAME = `${MACHINE_NAME}-agent-tools`;

/**
 * The two executables package.json `bin` installs: the command line and the stdio MCP server.
 * package.json `bin` also names the stdio server after the package (PACKAGE_NAME -> bin/mcp.js):
 * `npx -y bountymarket-agent-tools` and the MCP Registry's npx invocation (server.json, no
 * package arguments) run the bin named after the package, and npx cannot choose between two others.
 */
export const CLI_BIN = MACHINE_NAME;
export const MCP_BIN = `${MACHINE_NAME}-mcp`;

/** The public sandbox API origin (same rules as live, Stripe test mode, no real money). */
export const SANDBOX_API_URL = 'https://api.sandbox.bountymarket.online';

/**
 * The live API origin. It does not answer before launch; a release after launch makes it the
 * default again (DEFAULT_API_URL = LIVE_API_URL). Until then an owner reaches live by setting
 * BOUNTYMARKET_API_URL to it.
 */
export const LIVE_API_URL = 'https://api.bountymarket.online';

/**
 * Default API origin (BOUNTYMARKET_API_URL overrides it); server.json repeats it as the default
 * and its `/mcp` as the remote, plugin.json as the hosted endpoint. The sandbox until launch.
 */
export const DEFAULT_API_URL = SANDBOX_API_URL;

/** The sandbox website and the live website (the live one answers from launch). */
export const SANDBOX_WEBSITE_URL = 'https://sandbox.bountymarket.online';
export const LIVE_WEBSITE_URL = 'https://bountymarket.online';

/**
 * The website owners are sent to (server.json websiteUrl, plugin.json author.url): the sandbox
 * website while DEFAULT_API_URL is the sandbox; a release after launch switches it to LIVE_WEBSITE_URL.
 */
export const WEBSITE_URL = SANDBOX_WEBSITE_URL;

/** GitHub organisation that owns the public repository (the MCP Registry namespace follows it). */
export const GITHUB_OWNER = 'bounty-market';

/** Source repository (package.json repository / homepage / bugs, server.json repository, plugin.json). */
export const REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${PACKAGE_NAME}`;

/** MCP Registry name (package.json mcpName, server.json name): io.github.<GitHub owner>/<repository>. */
export const MCP_REGISTRY_NAME = `io.github.${GITHUB_OWNER}/${PACKAGE_NAME}`;
