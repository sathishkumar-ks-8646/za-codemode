#!/usr/bin/env node
/**
 * Zoho Analytics Code Mode — remote, multi-user server.
 *
 * UTCP code mode behind an MCP front door, deployed centrally.
 *
 * One centrally managed instance serving many users over HTTPS. Each user
 * signs in to Zoho through their browser; the server holds their tokens and
 * gives them a private operation catalog scoped to their organization.
 *
 * Environment variables mirror the self-hosted Zoho Analytics Remote MCP
 * Server, so an existing .env can be reused.
 */
import './quiet.mjs';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRemoteConfig } from './config.mjs';
import { createStore } from './remote/store.mjs';
import { ZohoOAuth } from './remote/zoho-oauth.mjs';
import { ZohoAnalyticsOAuthProvider } from './remote/provider.mjs';
import { SessionPool } from './remote/sessions.mjs';
import { createApp } from './remote/http.mjs';
import { Catalog } from './catalog.mjs';
import { Knowledge } from './knowledge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANUAL_PATH = process.env.ZA_MANUAL_PATH
  ?? join(HERE, '..', 'manual', 'analytics.utcp.json');
const KNOWLEDGE_PATH = process.env.ZA_KNOWLEDGE_PATH
  ?? join(HERE, '..', 'knowledge', 'knowledge.json');

const config = loadRemoteConfig();

if (config.problems.length) {
  console.error('\nZoho Analytics Code Mode (remote) — cannot start:\n');
  for (const p of config.problems) console.error(`  • ${p}`);
  console.error('\nSee the setup guide: guide/07-remote-deployment.html\n');
  process.exit(78);
}

// Count the operations once, so the tool descriptions can state the number
// without every session having to work it out.
const probe = new Catalog({
  config: { ...config, orgId: '' },
  tokens: { get: async () => 'startup-probe' },
  manualPath: MANUAL_PATH,
});
const operationCount = probe.exposedOperations;

let knowledge = null;
try {
  knowledge = new Knowledge(KNOWLEDGE_PATH);
} catch (err) {
  console.error(`[za] knowledge base unavailable (${err.message}); `
    + 'get_analytics_guide will not be offered');
}

const store = await createStore(config);
const zoho = new ZohoOAuth(config);
const provider = new ZohoAnalyticsOAuthProvider({ store, zoho, config });
const sessions = new SessionPool({ config, provider, manualPath: MANUAL_PATH });

const app = createApp({
  config, provider, sessions, operationCount, knowledge,
  domainBreakdown: probe.domainBreakdown,
});

const server = app.listen(config.port, () => {
  console.error(
    `[za] remote server on :${config.port} — ${operationCount}/${probe.totalOperations} operations`
    + ` (${config.allowWrites ? 'READ-WRITE' : 'read-only'}), storage ${config.storageBackend}`);
  console.error(`[za] public URL  ${config.publicUrl}`);
  console.error(`[za] redirect    ${config.publicUrl}/auth/callback`);
  console.error(`[za] orgs        ${config.orgIds.join(', ')}`);
  console.error(`[za] domains     ${Object.entries(probe.domainBreakdown)
    .map(([d, n]) => `${d}:${n}`).join(' ')}`);
  if (knowledge) {
    const kp = knowledge.provenance;
    console.error(`[za] knowledge   ${knowledge.size} guides, ${knowledge.errorCount} error codes`
      + ` (OKF ${kp.okfVersion ?? '?'}, ${kp.ageDays ?? '?'}d old)`);
    if (kp.stale) {
      console.error('[za] WARNING: documentation snapshot is over 90 days old.');
    }
  }
  if (config.allowWrites) {
    console.error('[za] WARNING: write operations are enabled. Model-written code can '
      + 'create, update and DELETE data for every user of this server.');
  }
});

async function shutdown(signal) {
  console.error(`[za] ${signal} — shutting down`);
  sessions.close();
  await new Promise((done) => server.close(done));
  await store.close();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { shutdown(signal).catch(() => process.exit(1)); });
}
