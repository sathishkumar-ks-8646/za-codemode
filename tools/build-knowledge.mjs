#!/usr/bin/env node
/**
 * Builds the shipped knowledge bundle from the Zoho Analytics OKF bundle.
 *
 * The source of truth is the published repository, not any local checkout:
 *
 *     https://github.com/zoho/analytics-okf
 *
 * Its root manifest.json names the current version, and that version's
 * llms.txt carries the full link list — the repository's own instruction is
 * to resolve the version from the manifest rather than hard-coding a
 * directory, so that is what this does.
 *
 * The full bundle is around 12 MB across 600+ files, far too much to ship or
 * to put in front of a model. This selects the parts that actually change the
 * code a model writes:
 *
 *   workflows/     multi-step playbooks — precisely the shape code mode is for
 *   foundations/   the conventions generated code gets wrong: criteria
 *                  grammar, CONFIG stringification, job polling, enums
 *   errors         one compact entry per code, extracted from the 922 KB
 *                  catalog so a failure can be explained without shipping it
 *
 *   npm run build:knowledge              # from the published repository
 *   node tools/build-knowledge.mjs --local ../v2.0/okf    # offline
 *   node tools/build-knowledge.mjs --verify ../v2.0/okf   # does local match?
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = 'https://raw.githubusercontent.com/zoho/analytics-okf/main';
const OUT = join(here, '..', 'knowledge', 'knowledge.json');

/** Foundations worth shipping, and why. Anything not listed is deliberately out. */
const FOUNDATIONS = {
  'filter-criteria-syntax': 'The SQL-like criteria grammar used to filter rows',
  'request-conventions': 'How CONFIG, headers and parameters must be sent',
  'asynchronous-jobs': 'Export and import jobs: creating, polling, downloading',
  'identifiers': 'Finding and resolving workspace, view and column IDs',
  'response-envelope': 'The shape of every success and failure response',
  'export-formats-and-enums': 'Export formats and their CONFIG options',
  'import-options-and-enums': 'Import modes, matching columns and CONFIG options',
  'http-status-codes': 'What each HTTP status means for this API',
  'rate-limits-and-quotas': 'Concurrency and request limits that affect loops',
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? true);
};
const localDir = flag('--local');
const verifyDir = flag('--verify');

// ---------------------------------------------------------------------------
// Fetching: from the published repository, or from a local checkout.
// ---------------------------------------------------------------------------

async function getRemote(path) {
  const res = await fetch(`${REPO}/${path}`);
  if (!res.ok) throw new Error(`${REPO}/${path} -> HTTP ${res.status}`);
  return res.text();
}

function getLocal(root, path) {
  // A local checkout holds the version directory's contents directly.
  const trimmed = path.replace(/^v[\d.]+\//, '');
  const file = join(root, trimmed);
  if (!existsSync(file)) throw new Error(`${file} not found`);
  return readFileSync(file, 'utf8');
}

/** Resolve which version directory to read, and how to read files from it. */
async function openSource() {
  if (localDir || verifyDir) {
    const root = localDir || verifyDir;
    const manifest = JSON.parse(getLocal(root, 'manifest.json'));
    return {
      origin: `local:${root}`,
      version: `v${manifest.version?.replace(/\.\d+$/, '') ?? '2.0'}`,
      manifest,
      read: (p) => Promise.resolve(getLocal(root, p)),
    };
  }

  // The repository's own guidance: read the root manifest, do not hard-code.
  const index = JSON.parse(await getRemote('manifest.json'));
  const version = index.latest ?? 'v2.0';
  const manifest = JSON.parse(await getRemote(`${version}/manifest.json`));
  return {
    origin: REPO,
    version,
    manifest,
    read: (p) => getRemote(p.startsWith('v') ? p : `${version}/${p}`),
  };
}

const stripFrontMatter = (text) => {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^(\w[\w-]*):\s*(.+)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: text.slice(end + 4).trimStart() };
};

/** OKF cross-links point at files we do not ship; keep the words, drop the link. */
const flattenLinks = (text) =>
  text.replace(/\[([^\]]+)\]\((?!https?:)[^)]+\)/g, '$1');

// ---------------------------------------------------------------------------

const source = await openSource();
console.log(`source: ${source.origin}`);
console.log(`version: ${source.version} (OKF bundle ${source.manifest.version}, `
  + `generated ${source.manifest.generated?.at ?? 'unknown'})`);

// The version's llms.txt is the published link index; use it to discover the
// workflow set rather than assuming filenames.
const llms = await source.read('llms.txt');
const workflowIds = [...new Set(
  [...llms.matchAll(/\/workflows\/([a-z0-9-]+)\.md/g)].map((m) => m[1]),
)].filter((id) => id !== 'index');

const docs = [];

for (const id of workflowIds) {
  const { meta, body } = stripFrontMatter(await source.read(`workflows/${id}.md`));
  docs.push({
    id, kind: 'workflow',
    title: meta.title ?? id,
    description: meta.description ?? '',
    body: flattenLinks(body).trim(),
  });
}

for (const [id, why] of Object.entries(FOUNDATIONS)) {
  const { meta, body } = stripFrontMatter(await source.read(`foundations/${id}.md`));
  docs.push({
    id, kind: 'reference',
    title: meta.title ?? id,
    description: meta.description ?? why,
    body: flattenLinks(body).trim(),
  });
}

// One compact entry per error code: the attribute table only. The
// per-operation "Raised by" tables are what make the source file 922 KB, and
// a model does not need them to recover from a failure.
const errors = {};
const errorDoc = await source.read('foundations/error-codes.md');

for (const chunk of errorDoc.split(/\n## Error /).slice(1)) {
  const code = /^(\d+)/.exec(chunk)?.[1];
  if (!code) continue;
  const field = (name) => {
    const row = new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, 'mi').exec(chunk);
    return row ? row[1].replace(/`/g, '') : undefined;
  };
  const meaning = field('Meaning');
  if (!meaning) continue;
  errors[code] = {
    meaning,
    resolution: field('Resolution'),
    http: field('HTTP status'),
    retryable: /^yes/i.test(field('Retryable') ?? ''),
  };
}

// ---------------------------------------------------------------------------
// --verify: does a local checkout match what is published?
// ---------------------------------------------------------------------------
if (verifyDir) {
  const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
  let drift = 0;
  for (const path of ['manifest.json', 'foundations/error-codes.md',
    'foundations/filter-criteria-syntax.md', 'workflows/export-data-asynchronously.md']) {
    const localText = getLocal(verifyDir, path);
    const remoteText = await getRemote(`v2.0/${path}`);
    const same = digest(localText) === digest(remoteText);
    if (!same) drift += 1;
    console.log(`  ${same ? 'match   ' : 'DIFFERS '} ${path}`);
  }
  console.log(drift
    ? `\n${drift} file(s) differ from the published bundle — rebuild from the repository.`
    : '\nThe local checkout matches the published bundle.');
  process.exit(drift ? 1 : 0);
}

const bundle = {
  builtAt: new Date().toISOString().slice(0, 10),
  source: {
    repository: 'https://github.com/zoho/analytics-okf',
    origin: source.origin,
    apiVersion: source.version,
    okfVersion: source.manifest.version ?? null,
    okfGeneratedAt: source.manifest.generated?.at ?? null,
    okfGeneratedBy: source.manifest.generated?.by ?? null,
  },
  docs,
  errors,
};

writeFileSync(OUT, JSON.stringify(bundle));

const bytes = JSON.stringify(bundle).length;
const workflows = docs.filter((d) => d.kind === 'workflow').length;
const references = docs.filter((d) => d.kind === 'reference').length;
console.log(`\n${workflows} workflows + ${references} references + `
  + `${Object.keys(errors).length} error codes`);
console.log(`knowledge.json: ${(bytes / 1024).toFixed(0)} KB`);
