/**
 * Agent Plugin manifest (plugin.json, 2026-10-30): the open
 * format Cursor Marketplace, skills.sh and Claude Code plugins read. It bundles the Skill
 * (skills/bountymarket-agent-tools/SKILL.md, a link to ./SKILL.md) with the hosted MCP endpoint. Its
 * values follow src/brand.ts and package.json, and it is a repository file, not part of the
 * npm package (test/pack.test.ts pins the file list).
 */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BRAND_NAME, DEFAULT_API_URL, LIVE_API_URL, MACHINE_NAME, MCP_REGISTRY_NAME, MCP_URI_SCHEME, PACKAGE_NAME, REPOSITORY_URL, SANDBOX_API_URL, SUPPORT_EMAIL, WEBSITE_URL } from '../src/brand.ts';
import { VERSION } from '../src/version.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string; files: string[]; license: string };
const plugin = JSON.parse(read('plugin.json')) as {
  name: string; displayName: string; version: string; description: string;
  author: { name: string; email: string; url: string }; homepage: string; repository: string; license: string; keywords: string[];
  skills: string; mcpServers: Record<string, { type: string; url: string; headers?: unknown }>; mcpServersNote: string;
};

describe('plugin.json (Agent Plugin manifest)', () => {
  it('names the package, the brand, the version, the repository and the mailbox from the module', () => {
    assert.equal(plugin.name, PACKAGE_NAME);
    assert.equal(plugin.displayName, BRAND_NAME);
    assert.equal(plugin.version, pkg.version);
    assert.equal(plugin.version, VERSION, 'bump plugin.json with package.json and src/version.ts');
    assert.equal(plugin.license, pkg.license);
    assert.equal(plugin.author.email, SUPPORT_EMAIL);
    assert.equal(plugin.author.url, WEBSITE_URL);
    assert.equal(plugin.homepage, `${REPOSITORY_URL}#readme`);
    assert.equal(plugin.repository, REPOSITORY_URL);
    assert.equal(plugin.repository, 'https://github.com/bounty-market/bountymarket-agent-tools');
    assert.equal(plugin.author.url, 'https://sandbox.bountymarket.online', 'the sandbox website until launch');
    assert.deepEqual((pkg as unknown as { author: unknown }).author, plugin.author, 'package.json author is the plugin author (the npm page shows it)');
    assert.ok(plugin.keywords.includes('mcp') && plugin.keywords.includes(MCP_URI_SCHEME), plugin.keywords.join(','));
    assert.ok(plugin.description.length >= 100 && plugin.description.length <= 1000, `${plugin.description.length} chars`);
    assert.match(plugin.description, /No tool chooses an amount or a payee/, 'the money rule is stated where a marketplace reviewer reads it');
    assert.doesNotMatch(read('plugin.json'), /\{\{[A-Z_]+\}\}/u, 'no unfilled template token');
  });

  it('points the one MCP server (key = the frozen serverInfo.name) at the hosted endpoint built from DEFAULT_API_URL, with no key baked in', () => {
    assert.deepEqual(Object.keys(plugin.mcpServers), [MCP_URI_SCHEME]);
    const server = plugin.mcpServers[MCP_URI_SCHEME]!;
    assert.equal(server.type, 'http');
    assert.equal(server.url, `${DEFAULT_API_URL}/mcp`);
    assert.equal(server.url, 'https://api.sandbox.bountymarket.online/mcp', 'the sandbox endpoint until launch');
    assert.equal(server.headers, undefined, 'anonymous by default: the read-only tools need no credential, and a key is never committed');
    assert.match(plugin.mcpServersNote, /Authorization: Bearer bhk_/);
    assert.ok(plugin.mcpServersNote.includes(SANDBOX_API_URL));
    assert.ok(plugin.mcpServersNote.includes('no real money'), 'the note says the sandbox moves no real money');
    assert.ok(plugin.mcpServersNote.includes(`after launch the live endpoint is ${LIVE_API_URL}/mcp`), 'the note says how to reach live after launch');
  });

  it('bundles the Skill: skills/<name>/SKILL.md is a link to the root SKILL.md and reads identical', () => {
    assert.equal(plugin.skills, './skills/');
    // The Agent Skills specification: the frontmatter name equals the Skill's folder name.
    assert.deepEqual(readdirSync(`${root}skills`), [PACKAGE_NAME]);
    const linked = `${root}skills/${PACKAGE_NAME}/SKILL.md`;
    assert.ok(lstatSync(linked).isSymbolicLink(), 'a relative link, so the Skill has one source');
    assert.equal(readFileSync(linked, 'utf8'), read('SKILL.md'));
    assert.equal(realpathSync(linked), realpathSync(`${root}SKILL.md`), 'the link resolves inside the repository, to the root SKILL.md');
    assert.match(read('SKILL.md'), new RegExp(`^name: ${PACKAGE_NAME}$`, 'mu'), 'the Skill frontmatter names the package');
  });

  it('the Skill frontmatter follows the Agent Skills specification and the decided bounty rules', () => {
    const frontmatter = read('SKILL.md').split('---\n')[1]!;
    const description = /^description: (.*)$/mu.exec(frontmatter)![1]!;
    assert.ok(description.length >= 1 && description.length <= 1024, `description ${description.length} characters (at most 1,024)`);
    assert.doesNotMatch(description, /: /u, 'a plain YAML scalar: no ": " inside');
    assert.match(description, /from A\$10, up to the Setter's tier limit/);
    for (const file of ['SKILL.md', 'README.md', 'docs/quickstart.md']) {
      assert.doesNotMatch(read(file), /A\$10 to A\$100|A\$200 per Setter per day/u, `${file}: the retired shadow-mode caps are not the bounty range`);
    }
    assert.doesNotMatch(read('SKILL.md'), /tool descriptions are two sentences each/u);
  });

  it('glama.json names the company account, and every GitHub link or registry name in the manifests and docs is the public repository', () => {
    const glama = JSON.parse(read('glama.json')) as { $schema: string; maintainers: string[] };
    assert.deepEqual(glama.maintainers, [MACHINE_NAME], 'the company GitHub account');
    const strays: string[] = [];
    for (const file of ['README.md', 'SKILL.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/quickstart.md', 'Dockerfile', 'package.json', 'server.json', 'plugin.json', 'glama.json', 'src/brand.ts']) {
      const text = read(file);
      for (const m of text.matchAll(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gu)) {
        const repo = m[0].replace(/\.+$/u, '').replace(/\.git$/u, '');
        if (`https://${repo}` !== REPOSITORY_URL && !/^github\.com\/\$\{/u.test(repo)) strays.push(`${file}: ${m[0]}`);
      }
      for (const m of text.matchAll(/io\.github\.[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+/gu)) {
        if (m[0] !== MCP_REGISTRY_NAME) strays.push(`${file}: ${m[0]}`);
      }
    }
    assert.deepEqual(strays, [], `every repository link is ${REPOSITORY_URL} and every registry name ${MCP_REGISTRY_NAME}`);
  });

  it('stays out of the npm package (a repository manifest for marketplaces that clone the repository)', () => {
    assert.ok(!pkg.files.includes('plugin.json') && !pkg.files.includes('skills'));
  });
});
