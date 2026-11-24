#!/usr/bin/env node
/**
 * Generates the operation catalog the server runs on, from the authored
 * OpenAPI specifications in v2.0/oas/*-grouped-api.json.
 *
 * Run this whenever the specs change:  npm run build:manual
 *
 * The manual is an INTERNAL artefact. It is never published and no user ever
 * sees it - which is precisely what makes UTCP workable here: the app holds the
 * OAuth credentials and refreshes the access token itself, so UTCP's missing
 * token-refresh hook stops being a problem.
 *
 * Five patches the stock OpenApiConverter needs for Zoho:
 *   1. auth      -> api_key, Authorization: Bearer ${ZA_ACCESS_TOKEN}
 *   2. base URL  -> ${ZA_BASE_URL} instead of a baked-in DC
 *   3. CONFIG    -> stringified-JSON string, not an object
 *   4. descriptions -> keep the full prose, not just `summary`
 *   5. responses -> dropped (they are the only place the remote GitHub $refs
 *                   appear, so skipping them keeps the build offline)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = 'https://raw.githubusercontent.com/zoho/analytics-oas/main/v2.0';
const OUT = join(here, '..', 'manual', 'analytics.utcp.json');

/** The ten grouped specifications that make up the v2 surface. */
const DOMAINS = [
  'data-modeling-schema', 'data-operations', 'dsml', 'org-management',
  'reports-dashboards', 'schedules-alerts', 'share-publish', 'user-groups',
  'views-management', 'workspace-management',
];

const args = process.argv.slice(2);
const localArg = args.indexOf('--local');
const localDir = localArg === -1 ? null : args[localArg + 1];

/**
 * Read the specifications, from the published repository by default.
 *
 * The source of truth is https://github.com/zoho/analytics-oas, so this
 * repository does not depend on a sibling checkout being present or current.
 * `--local <dir>` builds offline from a checkout instead.
 */
async function loadSpecs() {
  if (localDir) {
    const files = readdirSync(localDir).filter((f) => f.endsWith('-grouped-api.json'));
    console.log(`source: local:${localDir}`);
    return files.map((f) => [f.replace('-grouped-api.json', ''),
      JSON.parse(readFileSync(join(localDir, f), 'utf8'))]);
  }

  console.log(`source: ${REPO}`);
  const out = [];
  for (const domain of DOMAINS) {
    const res = await fetch(`${REPO}/${domain}-grouped-api.json`);
    if (!res.ok) throw new Error(`${domain}: HTTP ${res.status}`);
    out.push([domain, await res.json()]);
  }
  return out;
}

/** Resolve a local #/... pointer; leave remote refs alone. */
function deref(doc, node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 12) return node;
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, depth + 1));
  if (typeof node.$ref === 'string') {
    if (!node.$ref.startsWith('#/')) return { type: 'object' };   // remote: stub it
    let target = doc;
    for (const part of node.$ref.slice(2).split('/')) target = target?.[part];
    const { $ref, ...rest } = node;
    return { ...deref(doc, target, depth + 1), ...deref(doc, rest, depth + 1) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, depth + 1);
  return out;
}

/** Drop keys whose value is null/undefined - cuts the manual by ~40%. */
function prune(node) {
  if (Array.isArray(node)) return node.map(prune);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (v === null || v === undefined) continue;
      out[k] = prune(v);
    }
    return out;
  }
  return node;
}

const tools = [];

for (const [domain, doc] of await loadSpecs()) {

  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!op || typeof op !== 'object' || !op.operationId) continue;

      const params = (op.parameters ?? []).map((p) => deref(doc, p));
      const properties = {};
      const required = [];
      const headerFields = [];

      for (const p of params) {
        if (!p.name) continue;
        let schema = deref(doc, p.schema ?? { type: 'string' });

        // PATCH 3: CONFIG is sent as stringified, URL-encoded JSON. The OAS
        // types it as an object, which every HTTP client serialises wrongly.
        if (p.name === 'CONFIG') {
          const shape = schema?.properties
            ? `JSON object with keys: ${Object.keys(schema.properties).join(', ')}`
            : 'JSON object';
          schema = {
            type: 'string',
            description: `${p.description ?? ''} Pass a JSON.stringify()'d object. ${shape}.`,
          };
        }

        // UTCP's `headers` map is for STATIC values only — a "{argName}"
        // placeholder is sent literally. Input fields that belong in headers
        // must be named in `header_fields` instead, which is what makes
        // ZANALYTICS-ORGID actually reach the API.
        if (p.in === 'header') headerFields.push(p.name);
        properties[p.name] = schema;
        if (p.required) required.push(p.name);
      }

      // Request body, if any, flattened into the inputs.
      //
      // PATCH 5: the body is a BODY. The v2 convention is that the HTTP
      // method decides where CONFIG goes — query string on GET, a
      // form-encoded body field on POST, PUT and DELETE, a multipart part
      // when a file rides along. Leaving the body undeclared made UTCP sweep
      // every unconsumed argument into the query string, which measured
      // live fails three different ways: createTable answers 8504 "CONFIG
      // has not been sent" because it reads the body only, a 5 KB CONFIG is
      // a 400, and a 17 KB CONFIG is a 414 Request-URI Too Large.
      const body = deref(doc, op.requestBody ?? {});
      const multipart = body?.content?.['multipart/form-data']?.schema;
      const bodySchema = body?.content?.['application/json']?.schema
        ?? body?.content?.['application/x-www-form-urlencoded']?.schema
        ?? multipart;
      if (bodySchema?.properties) {
        for (const [k, v] of Object.entries(bodySchema.properties)) {
          properties[k] = k === 'CONFIG'
            ? { type: 'string', description: "JSON.stringify()'d object" }
            : v;
        }
        for (const r of bodySchema.required ?? []) required.push(r);
      }
      // The import endpoints upload a file part beside CONFIG, which no
      // single body field can express. They are flagged here and handled by
      // the host, which builds the multipart body itself.
      const upload = Boolean(multipart);
      const bodyField = !upload && bodySchema?.properties?.CONFIG
        && method.toUpperCase() !== 'GET' ? 'CONFIG' : undefined;

      tools.push(prune({
        name: op.operationId,
        // PATCH 4: keep the full prose, not just the summary. UTCP substitutes
        // ${...} across the WHOLE manual, descriptions included, so prose that
        // legitimately mentions a placeholder (deleteVariable documents
        // "${variableName} references") would throw at registration. Defuse it.
        description: [op.summary, op.description].filter(Boolean).join(' — ')
          .replace(/\$\{/g, '{'),
        tags: [domain, ...(op.tags ?? [])],
        inputs: { type: 'object', properties, required },
        outputs: { type: 'object' },
        tool_call_template: {
          call_template_type: 'http',
          http_method: method.toUpperCase(),
          // Named so UTCP lifts CONFIG out of the query string and sends it
          // as the request body. The host form-encodes the value on the way
          // out, because the wire format is `CONFIG=<url-encoded JSON>` and
          // not the bare JSON.
          body_field: bodyField,
          upload: upload || undefined,
          // PATCH 2: the DC is a variable, not a baked-in host.
          url: '${ZA_BASE_URL}' + path.replace(/\{([^}]+)\}/g, '{$1}'),
          content_type: upload ? 'multipart/form-data'
            : (bodyField ? 'application/x-www-form-urlencoded' : 'application/json'),
          header_fields: headerFields,
          // PATCH 1: Zoho accepts Bearer, so api_key auth on the Authorization
          // header is correct and avoids UTCP's client_credentials oauth2 path.
          auth: {
            auth_type: 'api_key',
            // UTCP sends the api_key value verbatim, so the scheme has to be
            // part of it. Zoho accepts Bearer as well as Zoho-oauthtoken.
            api_key: 'Bearer ${ZA_ACCESS_TOKEN}',
            var_name: 'Authorization',
            location: 'header',
          },
        },
      }));
    }
  }
}

const manual = {
  utcp_version: '1.0.0',
  manual_version: '2.0',
  source: {
    repository: 'https://github.com/zoho/analytics-oas',
    origin: localDir ? `local:${localDir}` : REPO,
    builtAt: new Date().toISOString().slice(0, 10),
  },
  tools,
};
writeFileSync(OUT, JSON.stringify(manual, null, 1));

const bytes = JSON.stringify(manual).length;
console.log(`${tools.length} tools -> ${OUT}`);
console.log(`manual size: ${(bytes / 1024).toFixed(0)} KB  (~${Math.round(bytes / 4 / 1000)}k tokens if sent whole)`);
