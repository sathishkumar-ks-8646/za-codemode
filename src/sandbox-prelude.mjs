/**
 * JavaScript injected ahead of every program the model writes.
 *
 * It exists because of one specific failure: a user says "analyse my profit
 * table", the table is actually called "Sales_Profit_by_Country", and a model
 * left to its own devices writes `v.viewName === 'profit'`, matches nothing,
 * and reports that no such table exists. The operation signatures cannot fix
 * that — nothing in them says how to go from a human's word to an ID.
 *
 * So the sandbox ships a resolver. `find.*` does fuzzy, ranked name matching
 * over workspaces, views and columns, caches within one execution, and always
 * reports what it searched so an empty result is distinguishable from a
 * narrow one.
 *
 * This is a string rather than a module because it has to be evaluated inside
 * the isolate, which cannot import anything.
 */
export const PRELUDE = String.raw`
const __cache = { workspaces: null, views: new Map(), columns: new Map(), meta: new Map() };

/** Workspace-scoped metadata that has a plain list operation. */
const __KINDS = {
  variable:  { op: 'getVariables',   listKey: 'variables',   nameKey: 'variableName',   idKey: 'variableId',   detail: 'variableType' },
  folder:    { op: 'getFolders',     listKey: 'folders',     nameKey: 'folderName',     idKey: 'folderId',     detail: 'folderDesc' },
  group:     { op: 'getGroups',      listKey: 'groups',      nameKey: 'groupName',      idKey: 'groupId',      detail: 'groupDesc' },
  datasource:{ op: 'getDatasources', listKey: 'dataSources', nameKey: 'datasourceName', idKey: 'datasourceId', detail: 'source' },
  formula:   { op: 'getAggregateFormulasInWorkspace', listKey: 'aggregateFormulas', nameKey: 'formulaName', idKey: 'formulaId', detail: 'expression' },
};

function __norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function __tokens(s) { return __norm(s).split(' ').filter(Boolean); }

/**
 * How well does a name answer a query? 0 means no match at all.
 * The band is deliberately legible: 100 exact, 75 substring, below 50 partial.
 */
function __score(name, query) {
  const n = __norm(name);
  const q = __norm(query);
  if (!n || !q) return { score: 0, matchedOn: 'none' };

  if (n === q) return { score: 100, matchedOn: 'exact name' };
  if (n.replace(/ /g, '') === q.replace(/ /g, '')) {
    return { score: 95, matchedOn: 'exact name ignoring separators' };
  }
  if (n.startsWith(q)) return { score: 88, matchedOn: 'name starts with the query' };
  if (n.includes(q)) return { score: 75, matchedOn: 'name contains the query' };

  const qt = __tokens(q);
  const nt = new Set(__tokens(n));
  if (!qt.length) return { score: 0, matchedOn: 'none' };

  const whole = qt.filter((t) => nt.has(t)).length;
  if (whole === qt.length) return { score: 70, matchedOn: 'all query words appear in the name' };

  const partial = qt.filter((t) => n.includes(t)).length;
  if (partial === 0) return { score: 0, matchedOn: 'none' };

  const ratio = Math.max(whole, partial) / qt.length;
  return {
    score: Math.round(30 + 35 * ratio),
    matchedOn: whole
      ? whole + ' of ' + qt.length + ' query words appear in the name'
      : partial + ' of ' + qt.length + ' query words appear as fragments',
  };
}

function __rank(items, query, nameOf, limit) {
  if (!query) return items.slice(0, limit).map((item) => ({ item, score: null, matchedOn: 'listed' }));
  return items
    .map((item) => ({ item, ...__score(nameOf(item), query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Reading results without getting a confidently wrong number.
 *
 * Both of these were found by running against a real organization, and both
 * fail silently rather than loudly:
 *
 *  - Export returns its rows as a FLAT ARRAY in 'data', not 'data.rows'.
 *    Reaching for 'data.rows' yields undefined, which a '?? []' turns into
 *    "no data" — a wrong answer that looks like a legitimate empty table.
 *  - Numbers come back FORMATTED: "$1,682.39", "14 February, 2022".
 *    Number("$1,682.39") is NaN, so a straight sum silently produces NaN or 0.
 */
const rows = {
  /** Rows out of any Analytics response, whatever shape it used. */
  of(response) {
    const d = response?.data ?? response;
    if (Array.isArray(d)) return d;
    for (const key of ['rows', 'views', 'workspaces', 'ownedWorkspaces', 'data']) {
      if (Array.isArray(d?.[key])) return d[key];
    }
    return [];
  },

  /** "$1,682.39" -> 1682.39, "45%" -> 45, "" -> null. Never NaN. */
  num(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    const cleaned = String(value).replace(/[^0-9.eE+-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  },

  /** Sum one column across rows, ignoring blanks. Reports what it skipped. */
  sum(list, column) {
    let total = 0; let counted = 0; let skipped = 0;
    for (const row of list) {
      const n = rows.num(row?.[column]);
      if (n === null) skipped += 1; else { total += n; counted += 1; }
    }
    return { total, counted, skipped };
  },

  /** Group and sum: { West: { total, counted, skipped }, ... } */
  groupSum(list, byColumn, sumColumn) {
    const out = {};
    for (const row of list) {
      const key = String(row?.[byColumn] ?? '(blank)');
      (out[key] ??= []).push(row);
    }
    return Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, rows.sum(v, sumColumn)]));
  },
};

const find = {
  /** Every workspace, ranked against an optional query. Cached. */
  async workspaces(query, { limit = 10 } = {}) {
    if (!__cache.workspaces) {
      const res = await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID });
      const d = res.data ?? {};
      __cache.workspaces = d.workspaces ?? d.ownedWorkspaces ?? [];
    }
    return __rank(__cache.workspaces, query, (w) => w.workspaceName, limit)
      .map((r) => ({
        workspaceId: String(r.item.workspaceId),
        workspaceName: r.item.workspaceName,
        score: r.score,
        matchedOn: r.matchedOn,
      }));
  },

  /** Views in one workspace, ranked. Cached per workspace. */
  async viewsIn(workspaceId, query, { limit = 10, viewTypes } = {}) {
    const key = String(workspaceId);
    if (!__cache.views.has(key)) {
      const config = {};
      if (viewTypes) config.viewTypes = viewTypes;
      const res = await za.getViews({
        'ZANALYTICS-ORGID': ORG_ID,
        'workspace-id': key,
        CONFIG: JSON.stringify(config),
      });
      __cache.views.set(key, res.data?.views ?? []);
    }
    return __rank(__cache.views.get(key), query, (v) => v.viewName, limit)
      .map((r) => ({
        viewId: String(r.item.viewId),
        viewName: r.item.viewName,
        viewType: r.item.viewType,
        workspaceId: key,
        score: r.score,
        matchedOn: r.matchedOn,
      }));
  },

  /**
   * Views matching a query across the organization.
   *
   * Searching every workspace costs one call each, so workspaces whose own
   * name matches the query are searched first, then the rest up to
   * maxWorkspaces. The return value says how many were actually searched.
   */
  async views(query, options = {}) {
    const { limit = 10, maxWorkspaces = 15, workspaceId, exhaustive = false } = options;
    if (workspaceId) {
      const hits = await find.viewsIn(workspaceId, query, { limit });
      return { matches: hits, searchedWorkspaces: 1, totalWorkspaces: 1, truncated: false };
    }

    const all = await find.workspaces(null, { limit: 1000 });
    const byRelevance = query
      ? [...all].sort((a, b) =>
          (__score(b.workspaceName, query).score) - (__score(a.workspaceName, query).score))
      : all;

    const intended = exhaustive ? byRelevance : byRelevance.slice(0, maxWorkspaces);

    // Calls are rate limited to protect the API, so a sweep over a large org
    // takes real time. Stop at the deadline rather than running into the
    // execution timeout, and report how far it got — a caller deciding
    // whether something exists must be able to tell "looked everywhere and
    // it is not there" from "ran out of time".
    const deadline = Date.now() + (options.budgetMs ?? 45000);
    const matches = [];
    let searchedCount = 0;

    for (const ws of intended) {
      if (searchedCount > 0 && Date.now() > deadline) break;
      const hits = await find.viewsIn(ws.workspaceId, query, { limit });
      searchedCount += 1;
      for (const hit of hits) matches.push({ ...hit, workspaceName: ws.workspaceName });
    }

    matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return {
      matches: matches.slice(0, limit),
      searchedWorkspaces: searchedCount,
      totalWorkspaces: all.length,
      truncated: all.length > searchedCount,
      complete: searchedCount >= all.length,
    };
  },

  /**
   * Workspace-scoped metadata other than views: variables, folders, groups,
   * datasources, aggregate formulas. All are plain list calls, so one table
   * drives them all.
   */
  async metadata(kind, workspaceId, query, { limit = 25 } = {}) {
    const spec = __KINDS[kind];
    if (!spec) {
      throw new Error('Unknown metadata kind "' + kind + '". Known: '
        + Object.keys(__KINDS).join(', '));
    }
    const key = kind + ':' + String(workspaceId);
    if (!__cache.meta.has(key)) {
      const res = await za[spec.op]({
        'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': String(workspaceId),
      });
      __cache.meta.set(key, res.data?.[spec.listKey] ?? []);
    }
    return __rank(__cache.meta.get(key), query, (x) => x[spec.nameKey], limit)
      .map((r) => ({
        kind,
        id: String(r.item[spec.idKey] ?? ''),
        name: r.item[spec.nameKey],
        workspaceId: String(workspaceId),
        detail: spec.detail ? r.item[spec.detail] : undefined,
        score: r.score,
        matchedOn: r.matchedOn,
      }));
  },

  /**
   * Resolve a named thing, or STOP.
   *
   * This is the one callers should use when the user named something. It
   * throws rather than returning, because a soft "not found" is a value a
   * program can ignore — and the damage case here is not an error, it is
   * quietly using sum_of_revenue when the user asked for sum_of_cost.
   *
   * Throws when there is no acceptable match, and when two are too close to
   * choose between. Never substitutes.
   */
  async require(kind, workspaceId, name, options = {}) {
    let candidates;
    if (kind === 'view' && !workspaceId) {
      // Org-wide: a STOP is a claim that the thing does not exist anywhere,
      // so it may only be made after looking everywhere. The default search
      // covers the most relevant workspaces; if that finds nothing we widen
      // to all of them before concluding absence. Declaring "no such view"
      // having searched 12 of 81 workspaces is a false negative, and just as
      // damaging as substituting the wrong one.
      let sweep = await find.views(name, { limit: 10 });
      if (!sweep.matches.length && sweep.truncated) {
        sweep = await find.views(name, { limit: 10, exhaustive: true });
      }
      candidates = sweep.matches;
      options.__scope = sweep;

      // An unfinished search cannot support a claim of absence. Say exactly
      // that, rather than reporting "no such view" from a partial look.
      if (!candidates.length && !sweep.complete) {
        console.log('__ZA_RESOLUTION_FAILED__ ' + JSON.stringify({ kind, name,
          message: 'STOPPED: could not finish searching for "' + name + '". Covered '
            + sweep.searchedWorkspaces + ' of ' + sweep.totalWorkspaces + ' workspaces '
            + 'before the time budget ran out, so absence cannot be confirmed. Ask the '
            + 'user which workspace it is in, then search that one directly.' }));
        throw new Error('STOPPED: could not finish searching for "' + name + '". Covered '
          + sweep.searchedWorkspaces + ' of ' + sweep.totalWorkspaces + ' workspaces. '
          + 'Ask the user which workspace it is in.');
      }
    } else if (kind === 'view') {
      candidates = await find.viewsIn(workspaceId, name, { limit: 10 });
    } else if (kind === 'column') {
      candidates = await find.columns(workspaceId, options.viewId, name, { limit: 50 });
    } else {
      candidates = await find.metadata(kind, workspaceId, name, { limit: 25 });
    }

    // Live orgs have several views called exactly "Sales". A label without
    // the workspace tells the user nothing and makes the choice unanswerable.
    const label = (c) => {
      const base = c.name ?? c.viewName ?? c.columnName;
      return c.workspaceName ? base + ' (in ' + c.workspaceName + ')' : base;
    };
    const strong = candidates.filter((c) => c.score >= 70);

    // Enforcement note: the throws below are not the guarantee. A program can
    // catch them and carry on with some other object, which is precisely the
    // failure this exists to prevent. So every refusal is also announced on a
    // sentinel line, and the HOST fails the whole execution when it sees one.
    // The throw is for the well-behaved case; the sentinel is for the rest.
    const __refuse = (message) => {
      console.log('__ZA_RESOLUTION_FAILED__ ' + JSON.stringify({ kind, name, message }));
      throw new Error(message);
    };

    if (strong.length === 0) {
      const all = kind === 'view'
        ? (workspaceId ? await find.viewsIn(workspaceId, null, { limit: 40 }) : [])
        : kind === 'column'
          ? await find.columns(workspaceId, options.viewId, null, { limit: 60 })
          : await find.metadata(kind, workspaceId, null, { limit: 40 });
      const scope = options.__scope
        ? ' Searched all ' + options.__scope.searchedWorkspaces + ' of '
          + options.__scope.totalWorkspaces + ' workspaces.'
        : '';
      __refuse('STOPPED: no ' + kind + ' matching "' + name + '".' + scope
        + ' Do not substitute another ' + kind + '. Available ' + kind + 's: '
        + (all.map(label).join(', ') || '(none)')
        + '. Report this to the user and ask which they meant.');
    }

    if (strong.length > 1 && (strong[0].score - strong[1].score) < 15) {
      __refuse('STOPPED: "' + name + '" is ambiguous — it matches '
        + strong.slice(0, 5).map((c) => label(c) + ' (' + c.score + ')').join(', ')
        + '. Do not pick one. Ask the user which they meant.');
    }

    return strong[0];
  },

  /** Column names of one view, ranked against an optional query. Cached. */
  async columns(workspaceId, viewId, query, { limit = 50 } = {}) {
    const key = String(workspaceId) + ':' + String(viewId);
    if (!__cache.columns.has(key)) {
      const res = await za.getViewDetails({
        'ZANALYTICS-ORGID': ORG_ID,
        'view-id': String(viewId),
        CONFIG: JSON.stringify({ withInvolvedMetaInfo: true }),
      });
      const v = res.data?.views ?? res.data?.view ?? res.data ?? {};
      __cache.columns.set(key, v.columns ?? v.columnList ?? []);
    }
    const all = __cache.columns.get(key);
    let ranked = __rank(all, query, (c) => c.columnName ?? c.name, limit);

    // A view has few columns, so an unmatched query should show them all
    // rather than nothing: "which column is revenue?" is better answered with
    // "there is no revenue, but there is Total Sales" than with silence.
    const unmatched = query && ranked.length === 0;
    if (unmatched) ranked = __rank(all, null, (c) => c.columnName ?? c.name, limit);

    const out = ranked.map((r) => ({
      columnName: r.item.columnName ?? r.item.name,
      dataType: r.item.dataType ?? r.item.columnType,
      score: r.score,
      matchedOn: r.matchedOn,
    }));
    if (unmatched) out.unmatchedQuery = query;
    return out;
  },

  /**
   * One-shot: turn a human's phrase into a workspace and view.
   *
   * Never guesses silently. If the best match is weak or several are close,
   * 'confident' is false and 'alternatives' carries the runners-up, so the
   * program can report the choice or ask rather than quietly analysing the
   * wrong table.
   */
  async resolve(query, options = {}) {
    const { matches, searchedWorkspaces, totalWorkspaces, truncated } =
      await find.views(query, { limit: 8, ...options });

    if (!matches.length) {
      const sample = (await find.workspaces(null, { limit: 25 })).map((w) => w.workspaceName);
      return {
        found: false,
        confident: false,
        query,
        searchedWorkspaces,
        totalWorkspaces,
        truncated,
        message: 'Nothing matched "' + query + '" in ' + searchedWorkspaces
          + ' of ' + totalWorkspaces + ' workspaces.',
        workspacesAvailable: sample,
      };
    }

    const [best, ...rest] = matches;
    const runnerUp = rest[0]?.score ?? 0;

    // Confident only when one candidate is strong and genuinely alone. Two
    // views that both contain the users word - "Profit Margin Trend" and
    // "Sales_Profit_by_Country" for "profit" - is the case where guessing
    // silently does real damage, so it counts as ambiguous however wide the
    // numeric gap happens to be.
    const strongCount = matches.filter((m) => m.score >= 70).length;
    const confident = best.score >= 70 && strongCount === 1 && (best.score - runnerUp) >= 15;

    return {
      found: true,
      confident,
      query,
      best,
      alternatives: rest.slice(0, 4),
      ambiguous: !confident && matches.length > 1
        ? 'Several views match. Report these to the user and let them choose rather '
          + 'than analysing one of them silently.'
        : undefined,
      searchedWorkspaces,
      totalWorkspaces,
      truncated,
    };
  },
};
`;
