/**
 * A mock Zoho Analytics v2 API, so the test suite runs offline.
 *
 * Speaks the real paths, the real stringified-JSON CONFIG convention and the
 * real three-call bulk export dance (create job -> poll -> download).
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

const FORMULAS = {
  '2375824000000022222': [
    { formulaId: '33000001', formulaName: 'Gross Margin', expression: 'sum(Profit)/sum(Sales)' },
  ],
};

/** Columns per view, for find.columns(). */
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

/** The only organization this mock knows about. Requests naming any other get
 *  7103 / 404 — the documented code for an organization that does not exist or
 *  is not visible to the caller. */
export const MOCK_ORG_ID = '2375824000000000001';

const jobs = new Map();
let jobSeq = 0;
const throttleState = {};

function matches(row, criteria = '') {
  const region = /"Region"\s*=\s*'([^']+)'/.exec(criteria);
  const since = /"Date"\s*>=\s*'([^']+)'/.exec(criteria);
  if (region && row.Region !== region[1]) return false;
  if (since && row.Date < since[1]) return false;
  return true;
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

    // View details, with columns when extended metadata is requested.
    if ((m = /^\/restapi\/v2\/views\/(\d+)$/.exec(path))) {
      const view = Object.values(VIEWS).flat().find((v) => v.viewId === m[1]);
      if (!view) return fail(7103, 404);
      const payload = { ...view };
      if (config.withInvolvedMetaInfo) payload.columns = COLUMNS[m[1]] ?? [];
      return send({ status: 'success', data: { views: payload } });
    }

    if ((m = /^\/restapi\/v2\/workspaces\/(\d+)\/views\/(\d+)\/data$/.exec(path))) {
      const rows = (ROWS[m[2]] ?? []).filter((r) => matches(r, config.criteria));
      // The live API puts export rows directly in `data`, as a flat array.
      return send({ status: 'success', data: rows });
    }

    if (req.method === 'POST'
        && (m = /^\/restapi\/v2\/bulk\/workspaces\/(\d+)\/views\/(\d+)\/data$/.exec(path))) {
      const jobId = String(9900000000000000000n + BigInt(++jobSeq));
      jobs.set(jobId, { viewId: m[2], polls: 0, criteria: config.criteria ?? '' });
      return send({ status: 'success', data: { jobId } });
    }

    if ((m = /^\/restapi\/v2\/bulk\/workspaces\/(\d+)\/exportjobs\/(\d+)$/.exec(path))) {
      const job = jobs.get(m[2]);
      if (!job) return fail(7103, 404);
      job.polls += 1;
      const done = job.polls >= 3;          // real jobs are not instant
      return send({ status: 'success', data: {
        jobId: m[2],
        jobStatus: done ? 'JOB COMPLETED' : 'JOB IN PROGRESS',
      } });
    }

    if ((m = /^\/restapi\/v2\/bulk\/workspaces\/(\d+)\/exportjobs\/(\d+)\/data$/.exec(path))) {
      const job = jobs.get(m[2]);
      if (!job) return fail(7103, 404);
      const rows = (ROWS[job.viewId] ?? []).filter((r) => matches(r, job.criteria));
      return send({ status: 'success', data: rows });
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
