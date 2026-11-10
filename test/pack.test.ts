/**
 * Publish readiness (2026-10-15.13: the quickstart's
 * `npx -y bountymarket-agent-tools` answered 404 because the package was never
 * published). `npm pack --dry-run --json` must list exactly what an install needs:
 * the bins, the compiled dist/ (plain JS plus .d.ts), the docs an agent reads, the
 * changelog and the registry manifest; never src/, test/, node_modules/ or a local .env.
 * 0.1.0 is the first public release (2026-11-10): `npx -y bountymarket-agent-tools`
 * starts the stdio server through the bin named after the package, the CLI is
 * `npx -y --package bountymarket-agent-tools bountymarket`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string; version: string; bin: Record<string, string>; files: string[]; scripts: Record<string, string>;
  publishConfig?: { access?: string }; engines: { node: string }; exports: Record<string, unknown>; license: string;
};

describe('npm pack contents', () => {
  it('package.json names the bins, whitelists files, builds on prepare and gates publish on the checks', () => {
    assert.equal(pkg.name, 'bountymarket-agent-tools');
    assert.equal(pkg.version, '0.1.0');
    assert.equal(pkg.license, 'MIT');
    assert.deepEqual(pkg.bin, { bountymarket: 'bin/cli.js', 'bountymarket-mcp': 'bin/mcp.js', 'bountymarket-agent-tools': 'bin/mcp.js' });
    assert.deepEqual(pkg.files, ['bin', 'dist', 'docs', 'SKILL.md', 'README.md', 'LICENSE', 'server.json', 'CHANGELOG.md']);
    assert.equal(pkg.scripts.build, 'tsc -p tsconfig.build.json');
    // Source comments are working notes for this repository; the published build carries none of them.
    assert.equal(JSON.parse(readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8')).compilerOptions.removeComments, true);
    assert.equal(pkg.scripts.prepare, 'npm run build');
    assert.match(pkg.scripts.prepublishOnly, /npm run typecheck && npm test && npm run check:parity && npm run build/);
    assert.equal(pkg.publishConfig?.access, 'public');
    assert.equal(pkg.engines.node, '>=22');
    assert.deepEqual(Object.keys(pkg.exports), ['.', './tools', './mcp', './package.json']);
  });

  it('npm pack --dry-run lists only bin/, dist/ (plain JS + d.ts), docs/quickstart.md, SKILL.md, README.md, CHANGELOG.md, LICENSE, server.json and package.json', () => {
    // `npm install` (prepare) builds dist/; the pack listing needs it present.
    assert.ok(existsSync(`${root}dist/mcp-server.js`), 'dist/ is built (npm install or npm run build)');
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const [report] = JSON.parse(raw) as Array<{ name: string; version: string; files: Array<{ path: string; size: number }>; unpackedSize: number }>;
    assert.equal(report!.name, pkg.name);
    assert.equal(report!.version, pkg.version);
    const paths = report!.files.map((f) => f.path).sort();
    for (const required of [
      'LICENSE', 'README.md', 'SKILL.md', 'CHANGELOG.md', 'docs/quickstart.md', 'package.json', 'server.json', 'bin/cli.js', 'bin/mcp.js',
      'dist/cli.js', 'dist/mcp-server.js', 'dist/mcp-main.js', 'dist/cli-main.js', 'dist/tools.js', 'dist/guides.js', 'dist/api.js', 'dist/actions.js', 'dist/version.js',
      'dist/api.d.ts', 'dist/tools.d.ts', 'dist/mcp-server.d.ts',
    ]) assert.ok(paths.includes(required), `${required} is packed`);
    for (const path of paths) {
      assert.ok(/^(bin\/|dist\/|docs\/|LICENSE$|README\.md$|SKILL\.md$|CHANGELOG\.md$|server\.json$|package\.json$)/.test(path), `${path} does not belong in the package`);
      assert.doesNotMatch(path, /\.ts$(?<!\.d\.ts)/, `${path}: dist/ is plain JS (plus .d.ts)`);
      assert.doesNotMatch(path, /^(src|test|node_modules|scripts|\.github)\//, path);
      assert.doesNotMatch(path, /\.env/, path);
    }
    assert.ok(report!.unpackedSize < 1_000_000, `unpacked ${report!.unpackedSize} B stays under 1 MB`);
  });

  it('the bins run the compiled dist/ and never the TypeScript sources', () => {
    for (const bin of ['bin/cli.js', 'bin/mcp.js']) {
      const text = readFileSync(`${root}${bin}`, 'utf8');
      assert.match(text, /^#!\/usr\/bin\/env node/, bin);
      assert.match(text, /\.\.\/dist\//, bin);
      assert.doesNotMatch(text, /src\//, bin);
    }
    assert.match(readFileSync(`${root}dist/tools.js`, 'utf8'), /from ["']\.\/guides\.js["']/, 'relative imports rewritten to .js');
  });

  it('the three docs an agent reads stay about 100 KB together, as README.md says', () => {
    const total = ['README.md', 'SKILL.md', 'docs/quickstart.md'].reduce((sum, file) => sum + statSync(`${root}${file}`).size, 0);
    assert.ok(total >= 85_000 && total <= 120_000, `${total} B: update the size sentence in README.md and AGENTS.md`);
    assert.match(readFileSync(`${root}README.md`, 'utf8'), /Together the three are about 100 KB/);
  });

  it('the bin targets are in the form npm expects (no "./", so npm publish auto-corrects nothing) and are executable in a clone', () => {
    for (const target of Object.values(pkg.bin)) {
      assert.doesNotMatch(target, /^\.\//, target);
      assert.ok((statSync(`${root}${target}`).mode & 0o111) !== 0, `${target} has the execute bit (git records 100755)`);
    }
  });

  it('the stdio bins answer --version and --help without starting the server and refuse other arguments', () => {
    for (const bin of ['bin/mcp.js']) {
      const version = spawnSync(process.execPath, [`${root}${bin}`, '--version'], { encoding: 'utf8', timeout: 5000, input: '' });
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout, `${pkg.version}\n`);
      assert.equal(version.stderr, '', 'no server banner: the server did not start');
      for (const flag of ['--help', '-h']) {
        const help = spawnSync(process.execPath, [`${root}${bin}`, flag], { encoding: 'utf8', timeout: 5000, input: '' });
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /^bountymarket-mcp \d+\.\d+\.\d+: the BountyMarket MCP server over stdio/);
        assert.match(help.stdout, /BOUNTYMARKET_API_KEY/);
        assert.equal(help.stderr, '');
      }
      assert.equal(spawnSync(process.execPath, [`${root}${bin}`, '-v'], { encoding: 'utf8', timeout: 5000, input: '' }).stdout, `${pkg.version}\n`);
      const bogus = spawnSync(process.execPath, [`${root}${bin}`, '--bogus'], { encoding: 'utf8', timeout: 5000, input: '' });
      assert.equal(bogus.status, 2);
      assert.match(bogus.stderr, /unknown argument "--bogus"/);
      assert.equal(bogus.stdout, '');
    }
  });

  it('the CLI survives a reader that closes early (EPIPE): exit 0, no stack trace', async () => {
    const child = spawn(process.execPath, [`${root}bin/cli.js`, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /EPIPE|Error/);
  });
});
