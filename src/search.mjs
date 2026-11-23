/**
 * Operation search.
 *
 * UTCP's built-in strategy is `tag_and_description_word_match` — plain keyword
 * matching. Measured against the real 203-operation manual it handles API
 * vocabulary well and user vocabulary badly:
 *
 *   "export rows from a view"            -> exportDataView            correct
 *   "how much revenue did we make"       -> getLastImportDetails      wrong
 *   "give me my sales numbers"           -> createAlert               wrong
 *
 * So this module does two things UTCP does not: it rewrites user words into
 * API words before searching, and it scores with field weights so a term in
 * the operation name counts for more than the same term buried in prose.
 */

/** User vocabulary -> the words that actually appear in our OAS descriptions. */
const SYNONYMS = {
  revenue: ['data', 'rows', 'export'],
  sales: ['data', 'rows', 'export'],
  money: ['data', 'rows', 'export'],
  income: ['data', 'rows', 'export'],
  earnings: ['data', 'rows', 'export'],
  numbers: ['data', 'rows'],
  figures: ['data', 'rows'],
  total: ['data', 'rows', 'export'],
  sum: ['data', 'rows', 'export'],
  download: ['export', 'data'],
  fetch: ['get', 'export'],
  pull: ['get', 'export'],
  retrieve: ['get'],
  show: ['get'],
  list: ['get'],
  read: ['get'],
  graph: ['chart', 'report'],
  visual: ['chart', 'report'],
  visualisation: ['chart', 'report'],
  visualization: ['chart', 'report'],
  dataset: ['table', 'view'],
  spreadsheet: ['table'],
  people: ['user'],
  member: ['user'],
  members: ['user'],
  staff: ['user'],
  permission: ['share', 'access'],
  permissions: ['share', 'access'],
  access: ['share'],
  cron: ['schedule'],
  recurring: ['schedule'],
  notify: ['alert'],
  notification: ['alert'],
  sql: ['query', 'table'],
  recent: ['recent', 'last'],
  latest: ['recent', 'last'],
  remove: ['delete'],
  drop: ['delete'],
  add: ['create', 'add'],
  make: ['create'],
  new: ['create'],
  rename: ['rename', 'update'],
  change: ['update'],
  edit: ['update'],
  modify: ['update'],
  upload: ['import'],
  load: ['import'],
  calculation: ['formula'],
  computed: ['formula'],
  field: ['column'],
  record: ['row'],
  entry: ['row'],
  folder: ['folder'],
  filter: ['criteria', 'config'],
  where: ['criteria'],
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'from', 'with', 'and', 'or',
  'my', 'our', 'me', 'we', 'i', 'is', 'are', 'was', 'were', 'be', 'do', 'does',
  'did', 'how', 'what', 'which', 'that', 'this', 'it', 'all', 'any', 'can',
  'want', 'need', 'please', 'give', 'got', 'have', 'has',
]);

/** "getOrgWorkspaces" -> ["get", "org", "workspaces"] */
function splitIdentifier(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
}

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Query terms plus their API-vocabulary synonyms, each with a weight. */
export function expandQuery(query) {
  const terms = new Map();
  for (const term of tokenize(query)) {
    terms.set(term, Math.max(terms.get(term) ?? 0, 1));
    for (const syn of SYNONYMS[term] ?? []) {
      terms.set(syn, Math.max(terms.get(syn) ?? 0, 0.6));   // weaker than a literal hit
    }
  }
  return terms;
}

/**
 * Field-weighted lexical score. A term in the operation name is worth far more
 * than the same term in a 2000-character description, which is exactly the
 * distinction UTCP's flat word match fails to make.
 */
function score(op, terms) {
  const nameTokens = new Set(splitIdentifier(op.name));
  const tagTokens = new Set(op.tags.flatMap(splitIdentifier));
  const descTokens = tokenize(op.description);
  const descCounts = new Map();
  for (const t of descTokens) descCounts.set(t, (descCounts.get(t) ?? 0) + 1);

  let total = 0;
  let matched = 0;

  for (const [term, weight] of terms) {
    let best = 0;
    if (nameTokens.has(term)) best = 10;
    else if (tagTokens.has(term)) best = 4;
    else if (descCounts.has(term)) best = 1 + Math.min(descCounts.get(term), 3) * 0.3;
    else if ([...nameTokens].some((n) => n.startsWith(term) || term.startsWith(n))) best = 3;

    if (best > 0) { matched += 1; total += best * weight; }
  }

  if (matched === 0) return 0;
  // Reward covering more of the query rather than hammering one term.
  return total * (matched / terms.size);
}

export class OperationSearch {
  #catalog;
  #operations;

  constructor(catalog) {
    this.#catalog = catalog;
    this.#operations = catalog.allOperations();
  }

  /**
   * Rank operations for a task description. Our scorer leads; UTCP's own
   * search contributes a small bonus so its matches are not lost.
   */
  async find(task, limit = 8, domain = null) {
    const terms = expandQuery(task);
    const scored = new Map();
    const pool = domain
      ? this.#operations.filter((op) => op.domain === domain)
      : this.#operations;

    for (const op of pool) {
      const s = score(op, terms);
      if (s > 0) scored.set(op.name, { op, score: s });
    }

    try {
      const utcpHits = await this.#catalog.searchRaw(task, limit);
      utcpHits.forEach((hit, index) => {
        if (domain && !scored.has(hit.name)
            && !pool.some((op) => op.name === hit.name)) return;
        const existing = scored.get(hit.name);
        const bonus = (utcpHits.length - index) * 0.5;
        if (existing) existing.score += bonus;
        else scored.set(hit.name, { op: hit, score: bonus });
      });
    } catch {
      // Our own scorer is sufficient; a UTCP search failure must not be fatal.
    }

    return [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ op }) => op);
  }
}

/**
 * Render operations as type-annotated call signatures.
 *
 * The annotations communicate argument shape; the code the model writes is
 * plain JavaScript, because the isolate has no compiler. tools.mjs says so in
 * both tool descriptions, and explain() catches it when a model copies them.
 */
export function renderSignatures(operations, globalName = 'za') {
  return operations.map((op) => {
    const required = new Set(op.inputs.required ?? []);
    const args = Object.entries(op.inputs.properties ?? {})
      .map(([key, schema]) => {
        const optional = required.has(key) ? '' : '?';
        const note = schema.description
          ? `   // ${schema.description.replace(/\s+/g, ' ').slice(0, 90)}`
          : '';
        return `  ${JSON.stringify(key)}${optional}: ${schema.type ?? 'any'};${note}`;
      })
      .join('\n');

    const summary = op.description.split('—')[0].trim().slice(0, 120);
    const tag = op.domain ? `  [${op.domain}${op.write ? ', write' : ''}]` : '';
    return `// ${summary}${tag}\nawait ${globalName}.${op.name}({\n${args}\n});`;
  }).join('\n\n');
}
