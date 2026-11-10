#!/usr/bin/env node
/**
 * Tool parity check. The local MCP server must describe exactly the same tools
 * (names, titles, descriptions, input schemas, annotations, auth requirement) and serve
 * the same guide resources (uri, name, title, description, mimeType, text) as
 * the hosted MCP endpoint of the platform.
 *
 * 1. Always: compares src/tools.ts with the snapshot test/fixtures/remote-tools.json.
 * 2. When the platform source is available (BOUNTYMARKET_SERVER_MCP, default
 *    ../bountyhunter/server/src/mcp.ts next to this repository): imports its
 *    `visibleTools` export and compares the live definitions too, and src/guides.ts
 *    must be that directory's guides.ts byte for byte apart from the brand import.
 *    With --update the snapshot is rewritten from the live definitions.
 *
 * Run with: node --experimental-strip-types scripts/check-parity.mjs [--update]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const snapshotPath = resolve(root, 'test/fixtures/remote-tools.json');
const update = process.argv.includes('--update');

const local = await import(pathToFileURL(resolve(root, 'src/tools.ts')).href);
const localTools = local.TOOL_SPECS.map((spec) => ({ ...local.describeTool(spec), requiresAgent: spec.requiresAgent }));
const localGuides = local.GUIDES.map((g) => ({ ...g }));

const canonical = (value) => JSON.stringify(value, (_key, v) => (
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
));

function compare(label, expected, actual) {
  const problems = [];
  const expectedNames = expected.map((t) => t.name);
  const actualNames = actual.map((t) => t.name);
  if (canonical(expectedNames) !== canonical(actualNames)) {
    problems.push(`tool names differ:\n  ${label}: ${expectedNames.join(', ')}\n  local: ${actualNames.join(', ')}`);
  }
  for (const tool of expected) {
    const mine = actual.find((t) => t.name === tool.name);
    if (!mine) continue;
    for (const field of ['title', 'description', 'inputSchema', 'annotations', 'requiresAgent']) {
      if (canonical(tool[field]) !== canonical(mine[field])) {
        problems.push(`${tool.name}.${field} differs:\n  ${label}: ${canonical(tool[field])}\n  local: ${canonical(mine[field])}`);
      }
    }
  }
  return problems;
}

function compareGuides(label, expected, actual) {
  const problems = [];
  if (canonical(expected.map((g) => g.uri)) !== canonical(actual.map((g) => g.uri))) {
    problems.push(`guide uris differ:\n  ${label}: ${expected.map((g) => g.uri).join(', ')}\n  local: ${actual.map((g) => g.uri).join(', ')}`);
  }
  for (const guide of expected) {
    const mine = actual.find((g) => g.uri === guide.uri);
    if (!mine) continue;
    for (const field of ['name', 'title', 'description', 'mimeType', 'text']) {
      if (guide[field] !== mine[field]) problems.push(`${guide.uri}.${field} differs:\n  ${label}: ${JSON.stringify(guide[field])}\n  local: ${JSON.stringify(mine[field])}`);
    }
  }
  return problems;
}

let failed = false;

// 1. snapshot
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const snapshotProblems = [...compare('snapshot', snapshot.tools, localTools), ...compareGuides('snapshot', snapshot.resources ?? [], localGuides)];
if (snapshotProblems.length) {
  failed = true;
  console.error(`Snapshot mismatch (${snapshotPath}):\n${snapshotProblems.join('\n')}`);
} else {
  console.log(`OK: ${localTools.length} tools and ${localGuides.length} guides match the snapshot.`);
}

// 2. live platform source, if present
const serverMcp = process.env.BOUNTYMARKET_SERVER_MCP ?? resolve(root, '../bountyhunter/server/src/mcp.ts');
if (!existsSync(serverMcp)) {
  console.log(`Platform source not found at ${serverMcp}; skipped the live comparison (set BOUNTYMARKET_SERVER_MCP to enable).`);
} else {
  const remote = await import(pathToFileURL(serverMcp).href);
  const agentActor = {
    userId: 'parity', authSubject: 'parity', isAdmin: false,
    agent: { id: 'parity', displayName: 'Parity', setterMode: 'always', hunterMode: 'always' },
  };
  const anonymous = new Set(remote.visibleTools(null).map((t) => t.name));
  // describeTool is the platform's own tools/list entry (2026-10-15.13: only the non-default annotations; since 2026-11-10, with title).
  const remoteTools = remote.visibleTools(agentActor).map((t) => ({ ...remote.describeTool(t), requiresAgent: !anonymous.has(t.name) }));
  const remoteGuides = remote.GUIDES.map((g) => ({ ...g }));
  const liveProblems = [...compare('platform', remoteTools, localTools), ...compareGuides('platform', remoteGuides, localGuides)];
  // src/guides.ts is a copy of the platform's file. The one allowed difference is the brand import
  // (2026-10-30): the platform reads MCP_URI_SCHEME from its src/domain/brand.ts, this package from ./brand.ts.
  const remoteGuidesSource = resolve(serverMcp, '..', 'guides.ts');
  if (existsSync(remoteGuidesSource)) {
    const expectedSource = readFileSync(remoteGuidesSource, 'utf8').replace("from '../../src/domain/brand.ts'", "from './brand.ts'");
    if (expectedSource !== readFileSync(resolve(root, 'src/guides.ts'), 'utf8')) {
      liveProblems.push(`src/guides.ts differs from ${remoteGuidesSource} (only the brand import line may differ; copy the file and point the import at ./brand.ts)`);
    }
  }
  if (liveProblems.length) {
    failed = true;
    console.error(`Live mismatch (${serverMcp}):\n${liveProblems.join('\n')}`);
  } else {
    console.log(`OK: ${remoteTools.length} tools and ${remoteGuides.length} guides match the platform source.`);
  }
  if (update) {
    const document = {
      protocolVersions: remote.MCP_PROTOCOL_VERSIONS ?? snapshot.protocolVersions,
      rpc: remote.RPC ?? snapshot.rpc,
      tools: remoteTools,
      resources: remoteGuides,
    };
    writeFileSync(snapshotPath, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`Snapshot rewritten from the platform source: ${snapshotPath}`);
  }
}

process.exit(failed && !update ? 1 : 0);
