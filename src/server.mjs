#!/usr/bin/env node
/**
 * Zoho Analytics Code Mode — local stdio server.
 *
 * UTCP code mode behind an MCP front door: the operation catalog is a UTCP
 * manual generated from the published OpenAPI specifications, and
 * @utcp/code-mode runs the model's program in a V8 isolate with those
 * operations bridged in.
 *
 * One user, one machine, credentials from the agent's configuration file. The
 * agent host spawns this process; nothing listens on a port.
 *
 * For a shared, multi-user deployment with browser sign-in and organization
 * access control, run src/remote.mjs instead.
 */
import './quiet.mjs';                 // must stay first — see quiet.mjs

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { TokenSource } from './auth.mjs';
import { Catalog } from './catalog.mjs';
import { OperationSearch } from './search.mjs';
import { registerTools } from './tools.mjs';
import { Knowledge } from './knowledge.mjs';
import { createAudit } from './audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANUAL_PATH = process.env.ZA_MANUAL_PATH
  ?? join(HERE, '..', 'manual', 'analytics.utcp.json');
const KNOWLEDGE_PATH = process.env.ZA_KNOWLEDGE_PATH
  ?? join(HERE, '..', 'knowledge', 'knowledge.json');

const config = await loadConfig();

if (config.problems.length) {
  console.error('\nZoho Analytics Code Execution — cannot start:\n');
  for (const p of config.problems) console.error(`  • ${p}`);
  console.error('\nRun `npx zoho-analytics-code-mode-mcp status` to see what was found,');
  console.error('or `login` to store credentials in this machine\'s keychain.\n');
  process.exit(78);                   // EX_CONFIG
}

const audit = await createAudit(config, { mode: 'local' });

const catalog = new Catalog({
  config, tokens: new TokenSource(config), manualPath: MANUAL_PATH, audit,
});

try {
  await catalog.init();
} catch (err) {
  console.error(`\nZoho Analytics Code Execution — startup failed:\n\n  ${err.message}\n`);
  process.exit(70);                   // EX_SOFTWARE
}

const session = { catalog, search: new OperationSearch(catalog), orgId: config.orgId };

// The OKF knowledge base is optional: without it the server still works, it
// just cannot explain how an operation behaves.
let knowledge = null;
try {
  knowledge = new Knowledge(KNOWLEDGE_PATH);
} catch (err) {
  console.error(`[za] knowledge base unavailable (${err.message}); `
    + 'get_analytics_guide will not be offered');
}

const breakdown = Object.entries(catalog.domainBreakdown)
  .map(([d, n]) => `${d}:${n}`).join(' ');

console.error(
  `[za] ready — ${catalog.exposedOperations}/${catalog.totalOperations} operations`
  + ` (${config.allowWrites ? 'READ-WRITE' : 'read-only'}), org ${config.orgId},`
  + ` ${config.analyticsUrl}`);
console.error(`[za] credentials — ${config.credentialSource}`);
console.error(`[za] audit — ${audit.describe()}`);
console.error(`[za] domains — ${breakdown}`);
if (knowledge) {
  const p = knowledge.provenance;
  console.error(`[za] knowledge — ${knowledge.size} guides, ${knowledge.errorCount} error codes`
    + ` (OKF ${p.okfVersion ?? '?'}, generated ${p.okfGeneratedAt?.slice(0, 10) ?? 'unknown'}`
    + `${p.ageDays === null ? '' : `, ${p.ageDays}d old`})`);
  if (p.stale) {
    console.error('[za] WARNING: the documentation snapshot is over 90 days old. '
      + 'Regenerate v2.0/okf and run `npm run build:knowledge`.');
  }
}

const server = new McpServer({ name: 'zoho-analytics-code-mode', version: '2.0.0' });
registerTools(server, () => session, {
  operationCount: catalog.exposedOperations,
  domains: config.domains,
  knowledge,
  audit,
  scope: () => ({ domains: config.domains, writes: config.allowWrites }),
});

// Give queued audit lines a chance to reach disk before the host kills us.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { audit.flush().finally(() => process.exit(0)); });
}

await server.connect(new StdioServerTransport());
