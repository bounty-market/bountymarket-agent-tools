/**
 * One brand module (src/brand.ts, 2026-10-30; mirror of the platform's src/domain/brand.ts):
 * the CLI, the MCP server, the User-Agent and the default API origin render from it, and the
 * rendered output is byte for byte what the literals produced before. package.json,
 * server.json, the bins, .env.example, the Dockerfile and the shipped docs cannot import the
 * module, so this test pins them to it: a rename or a domain move is one edit in src/brand.ts
 * and this test then names every file that still spells the old value.
 *
 * The literals pinned in the first case are the 2026-10-31 wording (the 2026-10-31 rename: the
 * machine name and every protocol identifier derived from it moved with the brand because
 * nothing had been published); on a later rename they change together with the module, except
 * the identifiers, which are frozen from the first publication on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_API_URL as API_DEFAULT } from '../src/api.ts';
import {
  BRAND_NAME, CLI_BIN, DEFAULT_API_URL, ENV_API_KEY, ENV_API_URL, ENV_PREFIX, ENV_WEB_URL, GITHUB_OWNER, LIVE_API_URL, LIVE_WEBSITE_URL, MACHINE_NAME, MCP_BIN, MCP_REGISTRY_NAME,
  MCP_SERVER_NAME, MCP_URI_SCHEME, OPENAPI_EXTENSION, PACKAGE_NAME, REPOSITORY_URL, SANDBOX_API_URL, SANDBOX_WEBSITE_URL, SUPPORT_EMAIL, WEBSITE_URL, WELL_KNOWN_MANIFEST_PATH,
  WELL_KNOWN_POLICY_PATH,
} from '../src/brand.ts';
import { GUIDES, GUIDE_URI_PREFIX, SCREENING_HOLD_SENTENCE, SERVER_INSTRUCTIONS, STRUCTURED_CONTENT_META_KEY } from '../src/tools.ts';
import { USER_AGENT, VERSION } from '../src/version.ts';
import { run } from '../src/cli.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  name: string; bin: Record<string, string>; keywords: string[]; repository: { url: string }; homepage: string; bugs: { url: string }; mcpName: string;
};
const serverJson = JSON.parse(read('server.json')) as {
  name: string; title: string; websiteUrl: string; repository: { url: string };
  packages: Array<{
    registryType: string; identifier: string; version: string; runtimeHint: string; transport: { type: string }; packageArguments?: unknown; runtimeArguments?: unknown;
    environmentVariables: Array<{ name: string; description: string; default?: string; isSecret: boolean; isRequired: boolean }>;
  }>;
  remotes: Array<{ type: string; url: string; headers: Array<{ name: string; description: string; placeholder: string; isRequired: boolean; isSecret: boolean }> }>;
};

describe('brand module', () => {
  it('carries today\'s values and the code renders them byte-identical to the former literals', async () => {
    assert.equal(BRAND_NAME, 'BountyMarket');
    assert.equal(MACHINE_NAME, 'bountymarket');
    assert.equal(MCP_URI_SCHEME, 'bountymarket');
    assert.equal(MCP_SERVER_NAME, 'bountymarket');
    assert.equal(WELL_KNOWN_MANIFEST_PATH, '/.well-known/bountymarket-agent.json');
    assert.equal(WELL_KNOWN_POLICY_PATH, '/.well-known/bountymarket-policy.json');
    assert.equal(OPENAPI_EXTENSION, 'x-bountymarket');
    assert.deepEqual([ENV_PREFIX, ENV_API_URL, ENV_API_KEY, ENV_WEB_URL], ['BOUNTYMARKET', 'BOUNTYMARKET_API_URL', 'BOUNTYMARKET_API_KEY', 'BOUNTYMARKET_WEB_URL']);
    assert.equal(PACKAGE_NAME, 'bountymarket-agent-tools');
    assert.equal(CLI_BIN, 'bountymarket');
    assert.equal(MCP_BIN, 'bountymarket-mcp');
    assert.equal(SANDBOX_API_URL, 'https://api.sandbox.bountymarket.online');
    assert.equal(LIVE_API_URL, 'https://api.bountymarket.online');
    assert.equal(DEFAULT_API_URL, 'https://api.sandbox.bountymarket.online', 'the public sandbox is the default until launch; a release after launch switches it back to LIVE_API_URL');
    assert.equal(SANDBOX_WEBSITE_URL, 'https://sandbox.bountymarket.online');
    assert.equal(LIVE_WEBSITE_URL, 'https://bountymarket.online');
    assert.equal(WEBSITE_URL, 'https://sandbox.bountymarket.online', 'the website owners are sent to follows the default origin (the sandbox until launch)');
    assert.equal(SUPPORT_EMAIL, 'hello@bountymarket.online', 'the platform\'s SUPPORT_EMAIL (legal.json CONTACT_EMAIL)');
    assert.equal(GITHUB_OWNER, 'bounty-market', 'the company GitHub organisation (2026-11-10)');
    assert.equal(REPOSITORY_URL, 'https://github.com/bounty-market/bountymarket-agent-tools');
    assert.equal(MCP_REGISTRY_NAME, 'io.github.bounty-market/bountymarket-agent-tools', 'the namespace follows the GitHub owner');
    assert.equal(API_DEFAULT, DEFAULT_API_URL, 'api.ts re-exports the module\'s origin');
    assert.equal(USER_AGENT, `bountymarket-agent-tools/${VERSION}`);
    assert.equal(GUIDE_URI_PREFIX, 'bountymarket://guide/');
    assert.deepEqual(GUIDES.map((g) => g.uri), ['errors', 'waiting', 'issue-flow', 'money', 'files'].map((n) => `bountymarket://guide/${n}`));
    assert.equal(STRUCTURED_CONTENT_META_KEY, 'bountymarket/structuredContent', 'protocol identifier derived from the machine name (src/brand.ts), as on the platform');
    assert.equal(GUIDES.find((g) => g.name === 'errors')!.text.includes('is x-bountymarket.errors in the OpenAPI document.'), true, 'the errors guide names the OpenAPI extension');
    assert.ok(SERVER_INSTRUCTIONS.startsWith('BountyMarket is an online task marketplace for AI agents and humans (AUD; Setters anywhere, Hunters in Australia). '), SERVER_INSTRUCTIONS);
    assert.ok(SERVER_INSTRUCTIONS.includes('(_meta {"bountymarket/structuredContent": true} adds structuredContent)'));
    assert.equal(SCREENING_HOLD_SENTENCE, 'Your listing is held for a founder check because it looks like it may need in-person work (BountyMarket is online-only at launch). If it is online, no action is needed; the founder will release it.');
    let out = '';
    const code = await run(['--help'], { stdout: (t) => { out += t; }, stderr: () => {}, env: {} });
    assert.equal(code, 0);
    assert.ok(out.startsWith(`bountymarket ${VERSION} — BountyMarket, a task marketplace for AI agents and humans (Australia, AUD, online tasks)\n`), out.slice(0, 200));
    assert.match(out, /^Usage: bountymarket <command> \[options\] \[--json\]$/mu);
    assert.match(out, /^ {4}BOUNTYMARKET_API_URL {3}API origin \(default https:\/\/api\.sandbox\.bountymarket\.online, the public sandbox: same rules, no real money;\n {27}after launch set https:\/\/api\.bountymarket\.online for live\)$/mu);
    assert.match(out, /The local stdio server \(bountymarket-mcp\) handles one request at a time\./u);
  });

  it('package.json and server.json name the package, the bins, the origin, the website and the repository from the module', () => {
    assert.equal(pkg.name, PACKAGE_NAME);
    assert.deepEqual(pkg.bin, { [CLI_BIN]: 'bin/cli.js', [MCP_BIN]: 'bin/mcp.js', [PACKAGE_NAME]: 'bin/mcp.js' }, 'the bin named after the package is the stdio server, so npx -y <package> starts it');
    assert.ok(pkg.keywords.includes(MCP_URI_SCHEME.toLowerCase()) || pkg.keywords.includes(BRAND_NAME.toLowerCase()), 'a brand keyword');
    assert.equal(pkg.repository.url, `git+${REPOSITORY_URL}.git`);
    assert.equal(pkg.repository.url, 'git+https://github.com/bounty-market/bountymarket-agent-tools.git');
    assert.equal(pkg.homepage, `${REPOSITORY_URL}#readme`);
    assert.equal(pkg.homepage, 'https://github.com/bounty-market/bountymarket-agent-tools#readme');
    assert.equal(pkg.bugs.url, `${REPOSITORY_URL}/issues`);
    assert.equal(pkg.bugs.url, 'https://github.com/bounty-market/bountymarket-agent-tools/issues');
    assert.equal(pkg.mcpName, MCP_REGISTRY_NAME);
    assert.equal(pkg.mcpName, 'io.github.bounty-market/bountymarket-agent-tools');

    assert.equal(serverJson.name, MCP_REGISTRY_NAME);
    assert.equal(serverJson.title, BRAND_NAME);
    assert.equal(serverJson.websiteUrl, WEBSITE_URL);
    assert.equal(serverJson.websiteUrl, 'https://sandbox.bountymarket.online');
    assert.equal(serverJson.repository.url, REPOSITORY_URL);
    assert.equal(serverJson.packages.length, 1);
    const [npm] = serverJson.packages;
    assert.equal(npm!.registryType, 'npm');
    assert.equal(npm!.identifier, PACKAGE_NAME);
    assert.equal(npm!.version, VERSION);
    // `npx -y bountymarket-agent-tools` runs the bin named after the package (the stdio server); the
    // registry's npx invocation passes no package or runtime arguments.
    assert.equal(npm!.runtimeHint, 'npx');
    assert.deepEqual(npm!.transport, { type: 'stdio' });
    assert.equal(npm!.packageArguments, undefined);
    assert.equal(npm!.runtimeArguments, undefined);
    assert.deepEqual(npm!.environmentVariables.map((v) => v.name), [ENV_API_KEY, ENV_API_URL]);
    assert.deepEqual(npm!.environmentVariables.map((v) => [v.isSecret, v.isRequired]), [[true, false], [false, false]]);
    const apiUrl = npm!.environmentVariables.find((v) => v.name === ENV_API_URL)!;
    assert.equal(apiUrl.default, DEFAULT_API_URL);
    assert.equal(apiUrl.description, `API origin. Defaults to the public sandbox ${SANDBOX_API_URL} (same rules, no real money) until launch; after launch set ${LIVE_API_URL} for live.`);
    const apiKey = npm!.environmentVariables.find((v) => v.name === ENV_API_KEY)!;
    assert.equal(apiKey.description, 'Agent API key (bhk_...) created by the account holder on the website. Optional: without it only the read-only tools are listed.');
    assert.deepEqual(serverJson.remotes.map((r) => [r.type, r.url]), [['streamable-http', `${DEFAULT_API_URL}/mcp`]]);
    assert.deepEqual(serverJson.remotes[0]!.headers, [{
      name: 'Authorization',
      description: 'Bearer bhk_... (an agent API key the account holder creates on the website). Optional: without it only the read-only tools are listed.',
      placeholder: 'Bearer bhk_...',
      isRequired: false,
      isSecret: true,
    }]);
  });

  it('the bins, .env.example and the Dockerfile use the bin names and the default origin', () => {
    assert.match(read('bin/cli.js'), new RegExp(`'${CLI_BIN}: dist/ is missing`, 'u'));
    assert.match(read('bin/mcp.js'), new RegExp(`'${MCP_BIN}: dist/ is missing`, 'u'));
    assert.match(read('bin/mcp.js'), new RegExp(`\`${MCP_BIN}: \\$\\{`, 'u'));
    assert.match(read('.env.example'), new RegExp(`^${ENV_API_URL}=${DEFAULT_API_URL.replaceAll('.', '\\.')}$`, 'mu'));
    assert.ok(read('.env.example').includes(`set ${LIVE_API_URL} for live`), '.env.example says how to reach live after launch');
    assert.match(read('.env.example'), new RegExp(`^${ENV_API_KEY}=$`, 'mu'));
    assert.match(read('.env.example'), new RegExp(`^${ENV_WEB_URL}=$`, 'mu'));
    assert.match(read('Dockerfile'), new RegExp(`-e ${ENV_API_KEY}=bhk_`, 'u'));
    assert.match(read('Dockerfile'), new RegExp(`docker build -t ${MCP_BIN} \\.`, 'u'));
    assert.match(read('Dockerfile'), new RegExp(` ${MCP_BIN}\n`, 'u'));
    assert.ok(read('Dockerfile').includes(`org.opencontainers.image.source="${REPOSITORY_URL}"`), 'the image label names the repository');
  });

  it('every brand-looking token in the shipped docs and manifests is a value of the module, an identifier derived from it, or a kept host / repository', () => {
    // Values of the module (brand, package, bins, registry name) and the hosts / mailbox / repository it spells.
    const renamed = new Set([
      BRAND_NAME, PACKAGE_NAME, `${PACKAGE_NAME}/tools`, `${PACKAGE_NAME}/mcp`, CLI_BIN, MCP_BIN, MCP_REGISTRY_NAME,
      DEFAULT_API_URL, `${DEFAULT_API_URL}/mcp`, SANDBOX_API_URL, `${SANDBOX_API_URL}/mcp`, LIVE_API_URL, `${LIVE_API_URL}/mcp`, WEBSITE_URL, SANDBOX_WEBSITE_URL, LIVE_WEBSITE_URL,
      REPOSITORY_URL, `${REPOSITORY_URL}.git`, `git+${REPOSITORY_URL}.git`, `${REPOSITORY_URL}/issues`, `${REPOSITORY_URL}#readme`,
      SUPPORT_EMAIL, WELL_KNOWN_MANIFEST_PATH, WELL_KNOWN_POLICY_PATH, WELL_KNOWN_MANIFEST_PATH.slice(1), WELL_KNOWN_POLICY_PATH.slice(1), STRUCTURED_CONTENT_META_KEY, MCP_SERVER_NAME,
    ]);
    // Identifiers derived from the machine name (src/brand.ts): spelled in the docs as the module builds them.
    const derived = [
      new RegExp(`^(process\\.env\\.)?${ENV_PREFIX}_(API_KEY|API_URL|WEB_URL|SERVER_MCP)$`, 'u'), // SERVER_MCP: the parity script's platform-path override
      new RegExp(`^${MCP_URI_SCHEME}://guide/[a-z-]*$`, 'u'),
      new RegExp(`^skills/${PACKAGE_NAME}/SKILL\\.md$`, 'u'), // plugin.json skills directory, named after the Skill (its frontmatter name)
      new RegExp(`^${OPENAPI_EXTENSION}(\\.[a-z_]+)?$`, 'u'),
    ];
    const oldName = /bounty[ -]?hunter/iu;
    const files = ['README.md', 'SKILL.md', 'docs/quickstart.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'CHANGELOG.md', '.env.example', 'Dockerfile', 'server.json', 'package.json', 'plugin.json', 'glama.json'];
    assert.doesNotMatch(read('SECURITY.md'), /\{\{[A-Z_]+\}\}/u, 'no unfilled template token (2026-10-30: {{CONTACT_EMAIL}} is the brand mailbox)');
    assert.ok(read('SECURITY.md').includes(`**${SUPPORT_EMAIL}**`), 'SECURITY.md names the support mailbox');
    const strays: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const match of text.matchAll(/[A-Za-z0-9_./:@+-]*bounty[ -]?(?:hunter|market)[A-Za-z0-9_./:@+-]*/giu)) {
        const token = match[0].replace(/[.:]+$/u, '');
        if (renamed.has(token) || derived.some((re) => re.test(token))) continue;
        // The old name may survive only inside a kept host, mailbox or repository URL (all in `renamed`); anywhere else it is a stray.
        if (oldName.test(token)) { strays.push(`${file}:${text.slice(0, match.index).split('\n').length}: ${token} (old name)`); continue; }
        const line = text.slice(0, match.index).split('\n').length;
        strays.push(`${file}:${line}: ${token}`);
      }
    }
    assert.deepEqual(strays, [], 'tokens that are neither a src/brand.ts value nor an identifier derived from it');
    assert.match(read('LICENSE'), new RegExp(`Copyright \\(c\\) \\d{4} ${BRAND_NAME} contributors`, 'u'));
  });
});
