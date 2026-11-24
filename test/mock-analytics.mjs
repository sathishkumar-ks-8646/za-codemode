/**
 * A mock Zoho Analytics v2 API, so the test suite runs offline.
 *
 * Speaks the real paths, the real stringified-JSON CONFIG convention and the
 * real three-call bulk export dance (create job -> poll -> download).
 *
 * Every shape here is one that was observed against a live organization, not
 * one read off the documentation — the previous version of this file returned
 * the documented shapes and hid two arithmetic bugs for it. Specifically:
 *
 *  - Both bulk export creators are GET with a CONFIG query parameter, not
 *    POST. POST on those paths is the IMPORT job.
 *  - Job progress is `jobCode`, a STRING ("1002" in progress, "1004" done),
 *    alongside a human `jobStatus`.
 *  - The download carries {"data": [...]} with no status envelope.
 *  - A criteria naming an unknown column is 7330 with HTTP 400, before any
 *    rows are produced.
 *  - A statement that is not a SELECT is 7402; an unknown table is 7409.
 */
import { createServer } from 'node:http';

const WORKSPACES = [
  { workspaceId: '2375824000000012345', workspaceName: 'Sales Data' },
  { workspaceId: '2375824000000067890', workspaceName: 'HR Analytics' },
  { workspaceId: '2375824000000011111', workspaceName: 'Marketing' },
  { workspaceId: '2375824000000022222', workspaceName: 'ZIA Agent' },
];

const VIEWS = {
  '2375824000000012345': [
    { viewId: '2375824000000020001', viewName: 'Sales Q3', viewType: 'Table' },
    { viewId: '2375824000000020002', viewName: 'Sales Q4', viewType: 'Table' },
    { viewId: '2375824000000020003', viewName: 'Regions', viewType: 'Table' },
  ],
  '2375824000000067890': [
    { viewId: '2375824000000020004', viewName: 'Headcount', viewType: 'Table' },
  ],
  '2375824000000011111': [
    { viewId: '2375824000000020005', viewName: 'Sales Funnel', viewType: 'Table' },
    { viewId: '2375824000000020006', viewName: 'Campaigns', viewType: 'Table' },
  ],
  // Modelled on a real organization: nobody types these names exactly.
  '2375824000000022222': [
    { viewId: '2375824000000020007', viewName: 'Sales_Profit_by_Country', viewType: 'Table' },
    { viewId: '2375824000000020008', viewName: 'Profit Margin Trend', viewType: 'Chart' },
    { viewId: '2375824000000020009', viewName: 'Customer Churn', viewType: 'Table' },
    // Measured live: a dashboard refuses BOTH export paths with 8119, and a
    // big table is the case where bounding the read with SQL pays for itself.
    { viewId: '2375824000000020010', viewName: 'Exec Dashboard', viewType: 'Dashboard' },
    { viewId: '2375824000000020011', viewName: 'Big Ledger', viewType: 'Table', rowCount: 250000 },
  ],
};

/** Workspace-scoped metadata, for find.metadata() and find.require(). */
const VARIABLES = {
  '2375824000000022222': [
    { variableId: '31000001', variableName: 'sum_of_cost', variableType: 1, variableDataType: 2 },
    { variableId: '31000002', variableName: 'region_filter', variableType: 1, variableDataType: 1 },
    { variableId: '31000003', variableName: 'fiscal_year_start', variableType: 1, variableDataType: 3 },
  ],
  // Two variables that both answer to "sum": resolution must refuse to choose.
  '2375824000000012345': [
    { variableId: '31000010', variableName: 'sum_of_cost', variableType: 1, variableDataType: 2 },
    { variableId: '31000011', variableName: 'sum_of_revenue', variableType: 1, variableDataType: 2 },
  ],
};

const FOLDERS = {
  '2375824000000022222': [
    { folderId: '32000001', folderName: 'Tables & Reports', folderDesc: '', isDefault: true },
    { folderId: '32000002', folderName: 'Finance', folderDesc: 'Quarterly packs' },
  ],
};

/**
 * Formulas, per view. Only one view has any — which is the point: the engine
 * must cost nothing on the tables that have none, and those are most of them.
 */
/** A dashboard renders views; it has no rows to export. Measured: 8119. */
function isDashboard(viewId) {
  return Object.values(VIEWS).flat()
    .some((v) => v.viewId === viewId && (v.viewType === 'Dashboard' || v.viewType === 'Tab'));
}

const VIEW_FORMULAS = {
  '2375824000000020007': {
    columns: [{ formulaId: '33000010', formulaName: 'Margin %', expression: 'Profit/Sales' }],
    aggregates: [{ formulaId: '33000001', formulaName: 'Gross Margin',
      expression: 'sum(Profit)/sum(Sales)' }],
  },
};

const FORMULAS = {
  '2375824000000022222': [
    { formulaId: '33000001', formulaName: 'Gross Margin', expression: 'sum(Profit)/sum(Sales)' },
  ],
};

/** Columns per view, for find.columns(). Views with rows derive theirs below. */
const COLUMNS = {
  '2375824000000020007': [
    { columnName: 'Country', dataType: 'PLAIN' },
    { columnName: 'Total Profit', dataType: 'NUMBER' },
    { columnName: 'Total Sales', dataType: 'NUMBER' },
    { columnName: 'Order Date', dataType: 'DATE' },
  ],
};

/**
 * Rows exactly as the live API returns them: values are FORMATTED STRINGS,
 * not numbers. Verified against a real organization — "$1,682.39", not
 * 1682.39. Returning numbers here hid a whole class of arithmetic bug.
 */
const ROWS = {
  '2375824000000020001': [
    { Region: 'East', Date: '2026-07-14', Product: 'Widget', Sales: 12000 },
    { Region: 'East', Date: '2026-08-02', Product: 'Gadget', Sales: 8400 },
    { Region: 'West', Date: '2026-07-21', Product: 'Widget', Sales: 5100 },
    { Region: 'East', Date: '2026-09-19', Product: 'Widget', Sales: 15500 },
    { Region: 'East', Date: '2026-06-11', Product: 'Gadget', Sales: 9900 },
  ],
  '2375824000000020002': [
    { Region: 'East', Date: '2026-10-03', Product: 'Widget', Sales: 21000 },
    { Region: 'East', Date: '2026-11-17', Product: 'Doohickey', Sales: 7300 },
    { Region: 'South', Date: '2026-10-28', Product: 'Widget', Sales: 4200 },
  ],
  '2375824000000020005': [
    { Region: 'East', Date: '2026-08-30', Product: 'Trial', Sales: 3300 },
    { Region: 'East', Date: '2026-09-05', Product: 'Demo', Sales: 6600 },
    { Region: 'North', Date: '2026-09-05', Product: 'Demo', Sales: 1200 },
  ],
};

// A table's columns are its rows' keys. Declaring them twice is a way to get
// them out of step, and a criteria pre-flight that checks against a stale
// column list is worse than no pre-flight at all.
for (const [viewId, rows] of Object.entries(ROWS)) {
  if (!COLUMNS[viewId] && rows.length) {
    COLUMNS[viewId] = Object.keys(rows[0]).map((columnName) => ({
      columnName,
      dataType: typeof rows[0][columnName] === 'number' ? 'NUMBER' : 'PLAIN',
    }));
  }
}

/** The only organization this mock knows about. Requests naming any other get
 *  7103 / 404 — the documented code for an organization that does not exist or
 *  is not visible to the caller. */
export const MOCK_ORG_ID = '2375824000000000001';

const jobs = new Map();
let jobSeq = 0;
const throttleState = {};

/**
 * Enough of the criteria grammar to exercise pushdown.
 *
 * Deliberately not a parser: it understands the handful of forms the engine
 * emits — =, !=, >, >=, <, <=, in, like, is null — joined by and/or, so a
 * test can assert that a filter really narrowed the result rather than that
 * the string reached the server. Anything it cannot read is treated as
 * matching everything, which fails loudly in a test expecting fewer rows.
 */
const CONDITION = /"([^"]+)"\s*(>=|<=|!=|<>|=|>|<|\s+not\s+in\s+|\s+in\s+|\s+not\s+like\s+|\s+like\s+|\s+is\s+not\s+null|\s+is\s+null)\s*(\([^)]*\)|'(?:[^']|'')*'|[-\d.]+)?/gi;

function unquote(literal) {
  if (literal === undefined) return undefined;
  const text = String(literal).trim();
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** A value as the mock stores it, comparable with a criteria literal. */
function comparable(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(n) && String(value ?? '').match(/[\d]/) ? n : String(value ?? '');
}

function evaluate(row, condition) {
  const [, column, rawOp, rawValue] = condition;
  const op = rawOp.trim().toLowerCase().replace(/\s+/g, ' ');
  const actual = row[column];

  if (op === 'is null') return actual === undefined || actual === null || actual === '';
  if (op === 'is not null') return !(actual === undefined || actual === null || actual === '');

  if (op === 'in' || op === 'not in') {
    const list = String(rawValue ?? '()').slice(1, -1).split(',')
      .map((v) => unquote(v.trim()));
    const hit = list.includes(String(actual));
    return op === 'in' ? hit : !hit;
  }

  if (op === 'like' || op === 'not like') {
    const pattern = String(unquote(rawValue) ?? '');
    const re = new RegExp('^' + pattern.split('%').map((s) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    const hit = re.test(String(actual ?? ''));
    return op === 'like' ? hit : !hit;
  }

  const expected = unquote(rawValue);
  const a = comparable(actual);
  const b = typeof a === 'number' ? Number(expected) : String(expected);
  switch (op) {
    case '=': return a === b;
    case '!=': case '<>': return a !== b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    default: return true;
  }
}

function matches(row, criteria = '') {
  const text = String(criteria ?? '').trim();
  if (!text) return true;
  const conditions = [...text.matchAll(CONDITION)];
  if (!conditions.length) return true;
  // One joiner for the whole expression is enough for the shapes the engine
  // produces; mixed and/or would need a real parser and no test needs one.
  const anyOf = /\bor\b/i.test(text) && !/\band\b/i.test(text);
  return anyOf
    ? conditions.some((c) => evaluate(row, c))
    : conditions.every((c) => evaluate(row, c));
}

/** The columns a view has, for the 7330 check and for selectedColumns. */
function columnsOf(viewId) {
  if (COLUMNS[viewId]) return COLUMNS[viewId].map((c) => c.columnName);
  const sample = (ROWS[viewId] ?? [])[0];
  return sample ? Object.keys(sample) : [];
}

/** Unknown column in a criteria is 7330 — before any rows are produced. */
function unknownColumn(viewId, criteria) {
  if (!criteria) return null;
  const have = new Set(columnsOf(viewId));
  if (!have.size) return null;
  for (const [, column] of String(criteria).matchAll(/"([^"]+)"/g)) {
    if (!have.has(column)) return column;
  }
  return null;
}

function project(list, selectedColumns) {
  if (!selectedColumns?.length) return list;
  return list.map((row) => Object.fromEntries(
    selectedColumns.filter((c) => c in row).map((c) => [c, row[c]])));
}

/**
 * A SELECT engine just large enough for the statements the builder emits.
 *
 * SELECT list (plain columns and sum/avg/min/max/count/count distinct),
 * FROM one table, WHERE, GROUP BY, ORDER BY, LIMIT/OFFSET. Anything it does
 * not understand throws, which surfaces as 7401 — the same code the real
 * server uses for a statement it will not run.
 */
function runSql(statement) {
  const text = String(statement).trim().replace(/\s+/g, ' ');
  if (!/^select\b/i.test(text)) {
    const err = new Error('Only SELECT query statements are allowed');
    err.code = 7402;
    throw err;
  }

  const m = /^select\s+(distinct\s+)?(.+?)\s+from\s+"?([^"\s]+(?:[^"]*)?)"?(?:\s+where\s+(.+?))?(?:\s+group by\s+(.+?))?(?:\s+having\s+(.+?))?(?:\s+order by\s+(.+?))?(?:\s+limit\s+(\d+))?(?:\s+offset\s+(\d+))?$/i
    .exec(text);
  if (!m) { const e = new Error('Unparseable statement'); e.code = 7401; throw e; }

  const [, distinct, selectList, tableRaw, where, groupBy, , orderBy, limit, offset] = m;
  const table = tableRaw.replace(/"/g, '').trim();

  const viewId = Object.values(VIEWS).flat()
    .find((v) => v.viewName.toLowerCase() === table.toLowerCase())?.viewId;
  if (!viewId) {
    const e = new Error(`The table '${table}' does not exist in this workspace.`);
    e.code = 7409;
    throw e;
  }

  let list = (ROWS[viewId] ?? []).filter((r) => matches(r, where));

  const terms = splitList(selectList).map(parseTerm);
  const groups = groupBy ? splitList(groupBy).map((g) => g.replace(/"/g, '').trim()) : [];

  let out;
  if (groups.length || terms.some((t) => t.fn)) {
    const buckets = new Map();
    for (const row of list) {
      const key = groups.map((g) => String(row[g] ?? '')).join('\u0000');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    if (!groups.length && !buckets.size) buckets.set('', []);
    out = [...buckets.values()].map((bucket) => {
      const record = {};
      for (const g of groups) record[g] = bucket[0]?.[g];
      for (const term of terms) {
        if (!term.fn) { if (!(term.alias in record)) record[term.alias] = bucket[0]?.[term.column]; continue; }
        record[term.alias] = String(apply(term, bucket));
      }
      return record;
    });
  } else {
    out = list.map((row) => {
      if (terms.length === 1 && terms[0].column === '*') return { ...row };
      return Object.fromEntries(terms.map((t) => [t.alias, row[t.column]]));
    });
    if (distinct) {
      const seen = new Set();
      out = out.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
    }
  }

  if (orderBy) {
    for (const clause of splitList(orderBy).reverse()) {
      const desc = /\bdesc\b/i.test(clause);
      const column = clause.replace(/\b(asc|desc)\b/i, '').replace(/"/g, '').trim();
      out = [...out].sort((a, b) => {
        const x = comparable(a[column]); const y = comparable(b[column]);
        return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
      });
    }
  }

  const from = offset ? Number(offset) : 0;
  if (limit) out = out.slice(from, from + Number(limit));
  else if (from) out = out.slice(from);
  return out;
}

/** Split a comma-separated clause, ignoring commas inside parentheses. */
function splitList(text) {
  const parts = []; let depth = 0; let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseTerm(term) {
  const aliased = /^(.*?)\s+as\s+"?([^"]+)"?$/i.exec(term);
  const body = (aliased ? aliased[1] : term).trim();
  const alias = aliased ? aliased[2] : body.replace(/"/g, '');

  const agg = /^(sum|avg|min|max|count)\s*\(\s*(distinct\s+)?(\*|"[^"]+")\s*\)$/i.exec(body);
  if (agg) {
    return {
      fn: agg[1].toLowerCase(), distinct: Boolean(agg[2]),
      column: agg[3].replace(/"/g, ''), alias,
    };
  }
  return { fn: null, column: body.replace(/"/g, ''), alias };
}

function apply(term, bucket) {
  if (term.fn === 'count') {
    if (term.column === '*') return bucket.length;
    const values = bucket.map((r) => r[term.column]).filter((v) => v !== undefined && v !== '');
    return term.distinct ? new Set(values.map(String)).size : values.length;
  }
  const numbers = bucket.map((r) => comparable(r[term.column]))
    .filter((n) => typeof n === 'number');
  if (!numbers.length) return 0;
  switch (term.fn) {
    case 'sum': return numbers.reduce((a, b) => a + b, 0);
    case 'avg': return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    case 'min': return Math.min(...numbers);
    case 'max': return Math.max(...numbers);
    default: return 0;
  }
}

export function startMockAnalytics(port = 0) {
  const requests = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    requests.push(`${req.method} ${path}`);

    let config = {};
    try { config = JSON.parse(url.searchParams.get('CONFIG') ?? '{}'); } catch { /* ignore */ }

    const send = (payload, status = 200) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    const fail = (code, status) => send({ status: 'failure', summary: { errorCode: code } }, status);

    // Organization scoping. Every v2 endpoint is org-scoped, and a header
    // naming an org the caller cannot reach is refused.
    const orgId = req.headers['zanalytics-orgid'];
    if (process.env.MOCK_DEBUG) console.error('[mock]', req.method, path, 'hdrs=' + JSON.stringify(req.headers));
    if (orgId && orgId !== MOCK_ORG_ID) return fail(7103, 404);

    // Simulate Zoho's frequency limit: ?__throttle=N fails the next N calls
    // to this path with 6045, exactly as the live API did under a fast sweep.
    const throttleFor = url.searchParams.get('__throttle');
    if (throttleFor) {
      const budget = Number(throttleFor);
      // Key by budget as well as path: two tests asking for different budgets
      // on the same endpoint must not share a counter.
      const key = path + ':' + budget;
      throttleState[key] = throttleState[key] ?? budget;
      if (throttleState[key] > 0) {
        throttleState[key] -= 1;
        return send({ status: 'failure', summary: 'EXCEEDING_USR_PLN_API_FREQ_COUNT',
          data: { errorCode: 6045, errorMessage: 'API request could not be processed.' } }, 400);
      }
    }

    let m;

    if (path === '/restapi/v2/orgs/workspaces' || path === '/restapi/v2/workspaces') {
      return send({ status: 'success', data: { workspaces: WORKSPACES, ownedWorkspaces: WORKSPACES } });
    }

    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/views$/.exec(path))) {
      let views = VIEWS[m[1]] ?? [];
      // The real API filters server-side when CONFIG.keyword is given.
      if (config.keyword) {
        const k = String(config.keyword).toLowerCase();
        views = views.filter((v) => v.viewName.toLowerCase().includes(k));
      }
      return send({ status: 'success', data: { views } });
    }

    // Workspace-scoped metadata lists.
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/variables$/.exec(path))) {
      return send({ status: 'success', data: { variables: VARIABLES[m[1]] ?? [] } });
    }
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/folders$/.exec(path))) {
      return send({ status: 'success', data: { folders: FOLDERS[m[1]] ?? [] } });
    }
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/groups$/.exec(path))) {
      return send({ status: 'success', data: { groups: [] } });
    }
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/datasources$/.exec(path))) {
      return send({ status: 'success', data: { dataSources: [] } });
    }
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/aggregateformulas$/.exec(path))) {
      return send({ status: 'success', data: { aggregateFormulas: FORMULAS[m[1]] ?? [] } });
    }
    // View-scoped formula lists. Empty for every view but the one that has
    // them, which is the normal case live: most tables define no formulas at
    // all, and the engine must not pay a call to discover that.
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/views\/(\d+)\/customformulas$/.exec(path))) {
      return send({ status: 'success', data: { customFormulas: VIEW_FORMULAS[m[2]]?.columns ?? [] } });
    }
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/views\/(\d+)\/aggregateformulas$/.exec(path))) {
      return send({ status: 'success',
        data: { aggregateFormulas: VIEW_FORMULAS[m[2]]?.aggregates ?? [] } });
    }
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/aggregateformulas\/(\d+)\/value$/.exec(path))) {
      return send({ status: 'success', data: { value: '0.3184' } });
    }

    // View details, with columns when extended metadata is requested. The
    // owning workspace is part of the answer, as it is live — it is what lets
    // a caller be told that the view is not in the workspace they named.
    if ((m = /^\/restapi\/v2\/views\/(\d+)$/.exec(path))) {
      const owner = Object.entries(VIEWS)
        .find(([, views]) => views.some((v) => v.viewId === m[1]));
      if (!owner) return fail(7103, 404);
      const view = owner[1].find((v) => v.viewId === m[1]);
      const payload = { ...view, workspaceId: owner[0] };
      if (config.withInvolvedMetaInfo) {
        payload.columns = COLUMNS[m[1]] ?? [];
        // Live, only a Table carries a usable count: a QueryTable reports 0
        // even when populated, and a chart or pivot reports none at all.
        if (view.viewType === 'Table') payload.rowCount = view.rowCount ?? (ROWS[m[1]] ?? []).length;
      }
      return send({ status: 'success', data: { views: payload } });
    }

    // Synchronous view export. criteria and selectedColumns are applied HERE,
    // by the server, which is the whole point of the pushdown path.
    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/views\/(\d+)\/data$/.exec(path))) {
      if (isDashboard(m[2])) return fail(8119, 400);
      const bad = unknownColumn(m[2], config.criteria);
      if (bad) return fail(7330, 400);
      const rows = project(
        (ROWS[m[2]] ?? []).filter((r) => matches(r, config.criteria)),
        config.selectedColumns);
      if (config.responseFormat === 'csv') {
        const cols = rows.length ? Object.keys(rows[0]) : [];
        const body = [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n');
        res.writeHead(200, { 'content-type': 'text/csv' });
        return res.end(body);
      }
      // The live API puts export rows directly in `data`, as a flat array.
      return send({ status: 'success', data: rows });
    }

    // Both export-job creators are GET with a CONFIG query parameter. POST on
    // the same paths is the IMPORT job, which is why the method matters.
    if (req.method === 'GET'
        && (m = /^\/restapi\/v2\/bulk\/workspaces\/(\d+)\/views\/(\d+)\/data$/.exec(path))) {
      if (isDashboard(m[2])) return fail(8119, 400);
      const bad = unknownColumn(m[2], config.criteria);
      if (bad) return fail(7330, 400);
      const jobId = String(9900000000000000000n + BigInt(++jobSeq));
      jobs.set(jobId, {
        viewId: m[2], polls: 0, criteria: config.criteria ?? '',
        selectedColumns: config.selectedColumns ?? null,
      });
      return send({ status: 'success', data: { jobId } });
    }

    // Export job from an ad-hoc SELECT. The statement is validated at create
    // time, as the live API does: a bad one never becomes a job.
    if (req.method === 'GET' && /^\/restapi\/v2\/bulk\/workspaces\/(\d+)\/data$/.test(path)) {
      if (!config.sqlQuery) return fail(7401, 400);
      let rows;
      try {
        rows = runSql(config.sqlQuery);
      } catch (err) {
        return fail(err.code ?? 7401, 400);
      }
      const jobId = String(9900000000000000000n + BigInt(++jobSeq));
      // tableCriteriaList is accepted and IGNORED, which is what the live
      // server was measured doing — a test asserting otherwise would be
      // asserting the documentation, not the API.
      jobs.set(jobId, { polls: 0, rows: project(rows, config.selectedColumns) });
      return send({ status: 'success', data: { jobId } });
    }

    if ((m = /^\/restapi\/v2\/bulk\/workspaces\/(\d+)\/exportjobs\/(\d+)$/.exec(path))) {
      const job = jobs.get(m[2]);
      if (!job) return send({ status: 'failure', summary: 'EXPORTJOBNOTFOUND',
        data: { errorCode: 8120 } }, 404);
      job.polls += 1;
      const done = job.polls >= 2;          // real jobs are not instant
      return send({ status: 'success', data: {
        jobId: m[2],
        jobCode: done ? '1004' : '1002',
        jobStatus: done ? 'JOB COMPLETED' : 'JOB IN PROGRESS',
      } });
    }

    if ((m = /^\/restapi\/v2\/bulk\/workspaces\/(\d+)\/exportjobs\/(\d+)\/data$/.exec(path))) {
      const job = jobs.get(m[2]);
      if (!job) return send({ status: 'failure', summary: 'EXPORTJOBNOTFOUND',
        data: { errorCode: 8120 } }, 404);
      if (job.polls < 2) return send({ status: 'failure', summary: 'EXPORTJOBNOTCOMPLETED',
        data: { errorCode: 8122 } }, 400);
      const rows = job.rows
        ?? project((ROWS[job.viewId] ?? []).filter((r) => matches(r, job.criteria)),
          job.selectedColumns);
      // The download has NO status envelope — just {"data": [...]}.
      return send({ data: rows });
    }

    return fail(7103, 404);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Allow running standalone: node test/mock-analytics.mjs 8788
if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startMockAnalytics(Number(process.argv[2] ?? 8788));
  console.log(`mock Zoho Analytics on ${url}`);
}
