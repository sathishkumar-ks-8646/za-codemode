/**
 * The data engine: read only the rows you need, not the whole table.
 *
 * It exists because of one measured failure. Asked for "total sales in the
 * West region", a model with nothing but `za.exportDataView` writes:
 *
 *     const out = await za.exportDataView({ ..., CONFIG: '{"responseFormat":"json"}' });
 *     const west = rows.of(out).filter((r) => r.Region === 'West');
 *
 * Against a real 755-row table that moves 130 KB over the wire to answer with
 * one number. Against a million-row table it moves ~170 MB, blows the
 * execution timeout, and bills ~3000 API units. The filter belongs on the
 * server, and Zoho Analytics has two places to put it:
 *
 *   - `criteria` in CONFIG — a SQL WHERE-clause expression, honoured by the
 *     synchronous view export and by both asynchronous export jobs. Measured
 *     live: it works on tables AND on charts, pivots, summary and tabular
 *     views, where it filters the underlying rows before aggregation.
 *   - `sqlQuery` in the bulk export job — a full SELECT, so WHERE, GROUP BY,
 *     ORDER BY, LIMIT and the aggregate functions all run inside Analytics.
 *
 * Measured against the same 755-row table (`Table` in workspace UTCP):
 *
 *     whole table, JSON                                   130388 bytes
 *     criteria "Region"='West'                             35721 bytes
 *     + selectedColumns ["Region","Sales"]                  3953 bytes
 *     SQL  SELECT "Region", SUM("Sales") GROUP BY "Region"    161 bytes
 *     SQL  SELECT COUNT(*)                                     32 bytes
 *
 * The last line is the point: the answer to "how much did the West sell" is
 * 161 bytes, not 130 KB — a 99.9% cut in what crosses into the model's
 * context, and the same cut in API units billed.
 *
 * Three behaviours here were established by probing the live API rather than
 * read off the documentation, and all three change what the code has to do:
 *
 *  1. `tableCriteriaList` on the SQL export job is SILENTLY IGNORED. Sending
 *     a filter for a table the statement does not even reference returns 200
 *     and unfiltered rows, where the documented behaviour is 7836. So this
 *     module never puts row selection there — it goes in the SQL WHERE, which
 *     does work. `tableCriteriaList` is passed through only if a caller
 *     insists, with the caveat attached to the result.
 *  2. The export job reports progress in `jobCode` ("1001".."1005") as a
 *     STRING, alongside a human `jobStatus`. Polling on jobStatus text alone
 *     is fragile; this polls jobCode and falls back to the text.
 *  3. The download returns `{"data": [...]}` with NO status envelope, and
 *     aggregate values come back as RAW numeric strings ("392075.70000000024")
 *     while raw column values stay FORMATTED ("$1,682.39"). Both go through
 *     `rows.num` before arithmetic.
 *
 * Like the rest of the prelude this is a string, because it is evaluated
 * inside the isolate and the isolate cannot import anything.
 */
export const DATA_PRELUDE = String.raw`
/**
 * Quoting, done once and in one place.
 *
 * Every criteria and SQL bug seen in generated code is a quoting bug: a
 * column name in single quotes, an apostrophe in a value ending the literal
 * early, a number quoted as a string so a > comparison compares text. The
 * builders below are the only supported way to get a value into an
 * expression, and they are shared by the sandbox and the query tool so there
 * is exactly one implementation to be right.
 */

/** "Order Date" -> '"Order Date"'. A quote inside an identifier is doubled. */
function __ident(name, table) {
  const col = '"' + String(name).replace(/"/g, '""') + '"';
  return table ? '"' + String(table).replace(/"/g, '""') + '".' + col : col;
}

/** 'O'Brien' -> "'O''Brien'". Numbers and booleans pass through unquoted. */
function __literal(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot put ' + value + ' in a filter.');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** The operators both criteria and SQL accept, mapped to their written form. */
const __OPS = {
  eq: '=', ne: '!=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
  '=': '=', '!=': '!=', '<>': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=',
  like: 'like', notlike: 'not like', 'not like': 'not like',
  in: 'in', notin: 'not in', 'not in': 'not in',
  between: 'between',
  isnull: 'is null', 'is null': 'is null',
  notnull: 'is not null', 'is not null': 'is not null',
  contains: 'like', startswith: 'like', endswith: 'like',
};

function __condition(f) {
  if (typeof f === 'string') return f;                     // already an expression
  if (!f || !f.column) {
    throw new Error('A filter needs a "column". Got ' + JSON.stringify(f) + '.');
  }
  const key = String(f.op ?? f.operator ?? 'eq').toLowerCase();
  const op = __OPS[key];
  if (!op) {
    throw new Error('Unknown filter operator "' + key + '". Known: '
      + Object.keys(__OPS).join(', ') + '.');
  }
  const col = __ident(f.column, f.table);

  if (op === 'is null' || op === 'is not null') return col + ' ' + op;

  if (op === 'in' || op === 'not in') {
    const list = Array.isArray(f.value) ? f.value : [f.value];
    if (!list.length) {
      throw new Error('"' + f.column + '" ' + op + ' () matches nothing. '
        + 'Drop the filter or give it values.');
    }
    return col + ' ' + op + ' (' + list.map(__literal).join(', ') + ')';
  }

  if (op === 'between') {
    const [lo, hi] = Array.isArray(f.value) ? f.value : [f.from, f.to];
    if (lo === undefined || hi === undefined) {
      throw new Error('between needs two values: { column, op: "between", value: [low, high] }.');
    }
    return col + ' >= ' + __literal(lo) + ' and ' + col + ' <= ' + __literal(hi);
  }

  if (op === 'like') {
    const raw = String(f.value ?? '');
    const pattern = key === 'contains' ? '%' + raw + '%'
      : key === 'startswith' ? raw + '%'
      : key === 'endswith' ? '%' + raw
      : raw;
    return col + " like " + __literal(pattern);
  }

  return col + ' ' + op + ' ' + __literal(f.value);
}

/**
 * Filters -> one expression.
 *
 * Accepts the three shapes a model naturally reaches for:
 *   { Region: 'West', Sales: { gt: 1000 } }            an object
 *   [{ column: 'Region', op: 'in', value: [...] }]     a list
 *   '"Region"=\'West\''                                a raw string, passed through
 */
function __where(filters, join) {
  if (filters === null || filters === undefined) return '';
  if (typeof filters === 'string') return filters.trim();
  const joiner = ' ' + String(join ?? 'and').trim().toLowerCase() + ' ';

  let list;
  if (Array.isArray(filters)) {
    list = filters;
  } else {
    list = Object.entries(filters).map(([column, spec]) => {
      if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
        const [op, value] = Object.entries(spec)[0] ?? [];
        return { column, op, value };
      }
      if (Array.isArray(spec)) return { column, op: 'in', value: spec };
      return { column, op: 'eq', value: spec };
    });
  }

  const parts = list.map(__condition).filter(Boolean);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : parts.map((p) => '(' + p + ')').join(joiner);
}

/** Aggregate functions Analytics accepts in a SELECT list. */
const __AGGS = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'stddev', 'variance']);

function __metric(m) {
  if (typeof m === 'string') return m;                     // raw SQL fragment
  const fn = String(m.fn ?? m.aggregate ?? 'sum').toLowerCase();
  if (!__AGGS.has(fn)) {
    throw new Error('Unknown aggregate "' + fn + '". Known: ' + [...__AGGS].join(', ') + '.');
  }
  const inner = m.column === '*' ? '*' : __ident(m.column, m.table);
  const expr = fn === 'count_distinct' ? 'count(distinct ' + inner + ')' : fn + '(' + inner + ')';
  const alias = m.as ?? m.alias
    ?? (m.column === '*' ? fn : fn + '_of_' + String(m.column).replace(/[^A-Za-z0-9]+/g, '_'));
  return expr + ' AS ' + __ident(alias);
}

/**
 * A SELECT statement from parts.
 *
 * Only SELECT is reachable: the server rejects anything else with 7402, and
 * this builder cannot emit anything else either — there is no path from a
 * spec object to a DELETE. A caller passing raw 'sql' bypasses the builder
 * but not the server's check.
 */
function __buildSql(spec) {
  const {
    table, columns, metrics, where, filters, filterJoin,
    groupBy, having, orderBy, limit, offset, distinct,
  } = spec;

  if (!table) throw new Error('A SQL read needs a "table" name (the table as it appears in Analytics).');

  const group = groupBy ? (Array.isArray(groupBy) ? groupBy : [groupBy]) : [];
  const select = [];
  for (const c of group) select.push(__ident(c, spec.tableAlias));
  for (const c of (columns ?? [])) {
    if (!group.includes(c)) select.push(typeof c === 'string' ? __ident(c, spec.tableAlias) : __metric(c));
  }
  for (const m of (metrics ?? [])) select.push(__metric(m));

  const parts = ['SELECT' + (distinct ? ' DISTINCT' : ''),
    select.length ? select.join(', ') : '*', 'FROM', __ident(table)];

  const clause = __where(filters ?? where, filterJoin);
  if (clause) parts.push('WHERE', clause);
  if (group.length) parts.push('GROUP BY', group.map((c) => __ident(c, spec.tableAlias)).join(', '));
  if (having) parts.push('HAVING', typeof having === 'string' ? having : __where(having, filterJoin));
  if (orderBy) {
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    parts.push('ORDER BY', list.map((o) => (typeof o === 'string'
      ? __ident(o)
      : __ident(o.column) + ' ' + (String(o.dir ?? o.direction ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC')
    )).join(', '));
  }
  if (limit !== undefined && limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new Error('limit must be a whole number of at least 1.');
    parts.push('LIMIT', String(n));
    if (offset) parts.push('OFFSET', String(Number(offset)));
  }
  return parts.join(' ');
}

/**
 * Which columns does an expression name?
 *
 * Used for a local pre-flight: a criteria naming a column the view does not
 * have fails with 7330 after a round trip, and the error names the column but
 * not the alternatives. Catching it here costs nothing and the message can
 * list what the view actually has.
 */
function __columnsIn(expression) {
  const names = new Set();
  const re = /"((?:[^"]|"")+)"/g;
  let m;
  while ((m = re.exec(String(expression ?? '')))) names.add(m[1].replace(/""/g, '"'));
  return [...names];
}

/**
 * One metadata call per view, not two.
 *
 * Measured live: getViewDetails with withInvolvedMetaInfo:true answers with
 * EVERYTHING the engine needs about a view, in a single 0.1-unit call -
 *
 *     viewName, viewType, workspaceId   routing and the name SQL addresses
 *     rowCount                          how big the read would be, BEFORE it
 *     columns[]                         columnName, dataType, dataTypeName,
 *                                       dateFormat, formulaDisplayName,
 *                                       isHidden, pkTableName/pkColumnName
 *
 * The column payload is the same shape getTableMetadata returns at ten times
 * the unit cost, so that operation is never worth calling. Before this, the
 * engine made the call twice per query - once bare for the name and type,
 * once with withInvolvedMetaInfo for the columns - because two caches were
 * keyed separately. One call now fills both.
 *
 * rowCount is the signal the router could not previously have: whether to
 * spend one call exporting the view or three bounding it with SQL is a
 * question about size, and the answer arrives free with the name.
 */
/**
 * Where "small enough to just read" ends; mirrors SMALL_TABLE_ROWS on the
 * host, which is the only other place the same judgement is made.
 *
 * Measured: a 755-row, seven-column table is 128 KB exported whole, about
 * 170 bytes a row. Past a thousand rows an unbounded export is producing -
 * and billing for - rows the result cap will discard.
 */
const __SMALL_TABLE_ROWS = 1000;

/**
 * Rows as a header plus arrays, instead of one object per row.
 *
 * A preview of twenty seven-column rows repeats every column name twenty
 * times; measured against the same table, the object form is 4063 bytes and
 * this one is under half that. The purpose of a preview is to show the shape
 * and the value formatting, and a header with aligned tuples shows both
 * without paying for the key names again on every line.
 *
 * Only preview uses it. Everything else returns objects, because a result a
 * program is going to compute with should not need an index to read.
 */
function __columnar(sample) {
  const columns = sample.length ? Object.keys(sample[0]) : [];
  return {
    columns,
    rows: sample.map((r) => columns.map((c) => r[c])),
    rowCount: sample.length,
    shape: 'rows[] are value arrays aligned to columns[]',
  };
}

const __dataCache = { raw: new Map(), meta: new Map(), formulas: new Map() };

/**
 * The one getViewDetails call, keyed by view id and shared with the resolver.
 *
 * Declared as a function so that find.columns - defined earlier, in the
 * resolver half of the prelude - can reach it through hoisting. Before this
 * the two halves each kept their own cache and each made the same call with a
 * different CONFIG, so every query that resolved a name AND checked a column
 * paid for the view's metadata twice.
 */
async function __viewDetail(viewId, { withColumns = true } = {}) {
  const key = String(viewId);
  const held = __dataCache.raw.get(key);
  // The extended response is a superset, so a cached full one answers a bare
  // request too. Only the reverse needs another call.
  if (held && (held.detailed || !withColumns)) return held;
  // withInvolvedMetaInfo is what adds the columns and the row count, and
  // measured live it costs about 2.6 KB more off the wire for the same 0.1
  // units. Worth it when either is going to be used - the row count decides
  // whether the read is bounded with SQL, which can save a 128 KB export -
  // and not worth it when all the caller wanted was the name SQL addresses.
  const res = await za.getViewDetails({
    'ZANALYTICS-ORGID': ORG_ID, 'view-id': key,
    CONFIG: JSON.stringify(withColumns ? { withInvolvedMetaInfo: true } : {}),
  });
  const v = res.data?.views ?? res.data?.view ?? res.data ?? {};
  const detail = {
    viewId: key,
    detailed: withColumns,
    viewName: v.viewName ?? null,
    viewType: v.viewType ?? null,
    workspaceId: v.workspaceId ? String(v.workspaceId) : null,
    rowCount: Number.isFinite(Number(v.rowCount)) ? Number(v.rowCount) : null,
    columns: (v.columns ?? v.columnList ?? []).map((c) => ({
      columnName: c.columnName ?? c.name,
      dataType: c.dataType ?? c.columnType,
      dataTypeName: c.dataTypeName ?? null,
      dateFormat: c.dateFormat ?? null,
      // A non-empty formulaDisplayName is how a formula column announces
      // itself. It costs nothing to read, which is the point: most tables
      // have no formula columns and must not pay a call to establish that.
      isFormula: Boolean(c.formulaDisplayName),
      isHidden: Boolean(c.isHidden),
      lookupTable: c.pkTableName || null,
    })),
  };
  __dataCache.raw.set(key, detail);
  return detail;
}

/**
 * Row counts are only meaningful where the server actually computes one.
 *
 * Measured live: a Table reports its real count, a QueryTable reports 0 even
 * when a SELECT against it returns rows, and a chart, pivot, summary or
 * tabular view reports nothing at all. Treating the QueryTable 0 as "empty"
 * would route a populated view down the cheap path for the wrong reason, so
 * only a Table's count is believed.
 */
function __knownRowCount(view) {
  return String(view.viewType) === 'Table' && Number.isFinite(view.rowCount)
    ? view.rowCount : null;
}

const data = {
  /** Expose the builders: useful on their own, and testable in isolation. */
  criteria: (filters, join) => __where(filters, join),
  sql: (spec) => __buildSql(spec),
  ident: __ident,
  literal: __literal,

  /**
   * Everything known about one view, from one cached call.
   *
   * Also the tenancy check: reading view X under workspace Y is how one
   * tenant gets answered with another tenant's numbers, so the pair is
   * verified here and nowhere else needs to repeat it.
   */
  async meta(workspaceId, viewId, { withColumns = true } = {}) {
    const key = String(workspaceId) + ':' + String(viewId);
    const held = __dataCache.meta.get(key);
    if (held && (held.detailed || !withColumns)) return held;

    let detail = null;
    try {
      const v = await __viewDetail(viewId, { withColumns });
      if (v.viewName) detail = { ...v, workspaceId: v.workspaceId ?? String(workspaceId) };
    } catch (err) {
      // Fall through to the list, which some deployments answer when the
      // detail call does not.
      console.log('getViewDetails did not answer for ' + viewId + ': ' + err.message);
    }

    if (!detail) {
      const all = await find.viewsIn(workspaceId, null, { limit: 1000 });
      const hit = all.find((v) => String(v.viewId) === String(viewId));
      if (!hit) {
        throw new Error('STOPPED: view ' + viewId + ' is not in workspace ' + workspaceId
          + '. Views there: ' + all.slice(0, 40).map((v) => v.viewName).join(', ') + '.');
      }
      detail = { viewId: String(viewId), detailed: withColumns, viewName: hit.viewName,
        viewType: hit.viewType ?? null, workspaceId: String(workspaceId),
        rowCount: null, columns: [] };
    }

    if (detail.workspaceId !== String(workspaceId)) {
      throw new Error('STOPPED: view ' + viewId + ' belongs to workspace '
        + detail.workspaceId + ', not ' + workspaceId + '. Reading it under the wrong '
        + 'workspace is how one tenant answers with another tenant numbers, so this '
        + 'stops. Resolve the workspace and the view together with find.resolve().');
    }
    __dataCache.meta.set(key, detail);
    return detail;
  },

  /** Name, type and owning workspace of one view. */
  async view(workspaceId, viewId) {
    return data.meta(workspaceId, viewId);
  },

  /**
   * Column names and types for a view.
   *
   * Empty for a chart, pivot, summary or tabular view: measured live, the
   * server returns column definitions only for tables and query tables.
   * Callers must treat an empty list as "unknown", never as "no columns".
   */
  async columns(workspaceId, viewId) {
    return (await data.meta(workspaceId, viewId, { withColumns: true })).columns;
  },

  /**
   * The formulas defined on a view - looked up ONLY when a name has already
   * missed against the real columns.
   *
   * Measured on a live organization: a workspace with no formulas answers
   * both of these with empty lists, so calling them speculatively would spend
   * 0.2 units per query to learn nothing. Most tables have no formula columns
   * and no aggregate formulas, so the happy path must never reach here. It is
   * the error path that benefits: "Revenue is not a column" is a worse answer
   * than "Revenue is an aggregate formula on this view, use metric instead".
   */
  async formulas(workspaceId, viewId) {
    const key = String(workspaceId) + ':' + String(viewId);
    if (__dataCache.formulas.has(key)) return __dataCache.formulas.get(key);
    const found = { columns: [], aggregates: [] };
    try {
      const r = await za.getCustomFormulaList({
        'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': String(workspaceId), 'view-id': String(viewId) });
      found.columns = (r.data?.customFormulas ?? r.customFormulas ?? []).map((f) => ({
        name: f.formulaName ?? f.columnName, id: f.formulaId ?? f.columnId,
        expression: f.expression ?? null }));
    } catch (err) { console.log('custom formulas unavailable: ' + err.message); }
    try {
      const r = await za.getAggregateFormulaList({
        'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': String(workspaceId), 'view-id': String(viewId) });
      found.aggregates = (r.data?.aggregateFormulas ?? r.aggregateFormulas ?? []).map((f) => ({
        name: f.formulaName, id: f.formulaId, expression: f.expression ?? null }));
    } catch (err) { console.log('aggregate formulas unavailable: ' + err.message); }
    __dataCache.formulas.set(key, found);
    return found;
  },

  /**
   * The live value of an aggregate formula the workspace already defines.
   *
   * One call, one number. When a customer has modelled "Gross Margin" as
   * sum(Profit)/sum(Sales), re-deriving it from a SQL export is three calls
   * to recompute something Analytics will hand over for one - and a ratio is
   * not expressible through groupBy + metrics at all. Find the id with
   * find.require('formula', workspaceId, name).
   */
  async metricValue(workspaceId, formulaId) {
    const r = await za.getAggregateFormulaValue({
      'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': String(workspaceId),
      'formula-id': String(formulaId) });
    const body = r.data ?? r;
    return { value: body.value ?? body.formulaValue ?? body, formulaId: String(formulaId),
      pushdown: { metric: 'computed by Analytics from the stored aggregate formula' } };
  },

  /**
   * The table name a SQL statement needs, from a view id.
   *
   * SQL addresses tables by the name shown in Analytics, not by id, so every
   * id-driven caller needs this translation.
   */
  async tableFor(workspaceId, viewId) {
    return (await data.meta(workspaceId, viewId, { withColumns: false })).viewName;
  },

  /**
   * Can a SELECT name this view?
   *
   * Measured live: a table and a query table can; a chart, pivot, summary,
   * tabular view or dashboard answers 7409, "the table does not exist in this
   * workspace", which reads as a missing object rather than as the wrong tool
   * for this view type. So the question is asked before the call.
   */
  sqlAddressable(viewType) {
    return viewType === null || viewType === undefined
      || ['Table', 'QueryTable'].includes(String(viewType));
  },

  /**
   * Is this view big enough that reading it whole is a waste?
   *
   * Only a Table reports a usable count, so every other view type answers
   * false and takes the cheap path - which is correct, because for those the
   * view export is the only path there is.
   */
  isLarge(view) {
    const n = __knownRowCount(view ?? {});
    return n !== null && n > __SMALL_TABLE_ROWS;
  },

  /**
   * Does this view hold row data at all?
   *
   * Measured live: a dashboard refuses BOTH the synchronous export and the
   * export job with 8119, "Invalid value 'json'" - it renders, it does not
   * tabulate. Retrying the other export path is wasted; the answer is the
   * views the dashboard is built from.
   */
  exportable(viewType) {
    return String(viewType) !== 'Dashboard' && String(viewType) !== 'Tab';
  },

  /**
   * Refuse a filter that names something the view does not have.
   *
   * Returns the checked expression. A mismatch costs 7330 after a wasted
   * round trip, and that error names the column but not the alternatives.
   * Checking locally costs nothing because the columns arrived with the name.
   *
   * Only when a name misses is it worth asking whether it is a formula -
   * one extra call, on the path that was going to fail anyway.
   */
  async checkCriteria(workspaceId, viewId, expression) {
    const text = String(expression ?? '').trim();
    if (!text) return '';
    const named = __columnsIn(text);
    if (!named.length) return text;

    const cols = await data.columns(workspaceId, viewId);
    // No column list means no check. Refusing a filter because the server
    // does not publish columns for this view type would turn a working query
    // into a dead end - measured, charts and pivots return none.
    if (!cols.length) return text;
    const have = new Set(cols.map((c) => c.columnName));
    // A qualified reference names the table too; a name that matches the view
    // itself is a table qualifier, not a missing column.
    const view = await data.meta(workspaceId, viewId);
    have.add(view.viewName);
    const missing = named.filter((n) => !have.has(n));
    if (missing.length && missing.length === named.length) {
      const formulas = await data.formulas(workspaceId, viewId);
      const asFormula = [...formulas.columns, ...formulas.aggregates]
        .filter((f) => missing.includes(f.name));
      if (asFormula.length) {
        const agg = formulas.aggregates.filter((f) => missing.includes(f.name));
        if (agg.length) {
          throw new Error('STOPPED: "' + agg[0].name + '" is an aggregate formula on this '
            + 'view, not a column, so it cannot appear in a filter. Read its value with '
            + 'data.metricValue(' + JSON.stringify(String(workspaceId)) + ', '
            + JSON.stringify(String(agg[0].id)) + ') instead.');
        }
        // A formula COLUMN is a real column the metadata call did not list.
        // It filters like any other, so let it through.
        return text;
      }
      throw new Error('STOPPED: the filter names ' + missing.map((m) => '"' + m + '"').join(', ')
        + ', which ' + (missing.length === 1 ? 'is not a column' : 'are not columns')
        + ' of this view. Columns: ' + cols.map((c) => c.columnName).join(', ')
        + (formulas.aggregates.length
          ? '. Aggregate formulas: ' + formulas.aggregates.map((f) => f.name).join(', ') : '')
        + '. Fix the filter — do not drop it and filter in code.');
    }
    return text;
  },

  /**
   * Rows from a view, filtered and projected BY THE SERVER.
   *
   * This is the replacement for "export everything and filter in JavaScript".
   * Every narrowing argument maps to a CONFIG attribute the API applies before
   * it builds the file:
   *
   *     filters / criteria  -> CONFIG.criteria        fewer rows
   *     columns             -> CONFIG.selectedColumns fewer columns
   *
   * Works on every view type. On a chart, pivot or summary view the criteria
   * filters the underlying rows and the response is the aggregate — measured
   * live, a summary view with one criteria answers in a single row.
   *
   * 'limit' is applied here, after the download, because the synchronous
   * export has no row-limit attribute. It caps what reaches the model, not
   * what crosses the network — use data.query() with a SQL LIMIT when the
   * table is large enough for that to matter, and this says so in the result.
   */
  async rows(options = {}) {
    const {
      workspaceId, viewId, filters, criteria, filterJoin,
      columns, limit, offset, format = 'json', validate = true,
    } = options;

    if (!workspaceId || !viewId) {
      throw new Error('data.rows needs workspaceId and viewId. Resolve them with find.resolve() '
        + 'or find.require("view", workspaceId, name).');
    }

    let expression = __where(filters ?? criteria, filterJoin);
    if (expression && validate) {
      expression = await data.checkCriteria(workspaceId, viewId, expression);
    }

    const config = { responseFormat: format };
    if (expression) config.criteria = expression;
    if (columns && columns.length) config.selectedColumns = columns;
    if (options.config) Object.assign(config, options.config);

    const started = Date.now();
    const response = await za.exportDataView({
      'ZANALYTICS-ORGID': ORG_ID,
      'workspace-id': String(workspaceId),
      'view-id': String(viewId),
      CONFIG: JSON.stringify(config),
    });

    if (format !== 'json') {
      return { format, body: response?.data ?? response, criteria: expression || null,
        columns: columns ?? null, ms: Date.now() - started };
    }

    const all = rows.of(response);
    // The synchronous export has neither a limit nor an offset attribute, so
    // both are applied here — to what reaches the model, not to what crossed
    // the network. Saying so is the point: a window that was applied after
    // the download is a window that cost full price, and the caller needs to
    // know to move it into SQL. Silently honouring an offset would be worse
    // still, because page two would look as cheap as page one.
    const from = offset ? Number(offset) : 0;
    const windowed = (from || limit) ? all.slice(from, limit ? from + limit : undefined) : all;
    return {
      rows: windowed,
      rowCount: windowed.length,
      rowsAvailable: all.length,
      truncated: windowed.length < all.length,
      pushdown: {
        criteria: expression || null,
        selectedColumns: columns ?? null,
        limitAppliedBy: (limit || from) && all.length > windowed.length ? 'client' : null,
        offsetAppliedBy: from ? 'client' : null,
      },
      ms: Date.now() - started,
    };
  },

  /**
   * Run a SELECT inside Analytics and bring back only its result.
   *
   * Three calls — create the job, poll it, download — wrapped so a program
   * does not have to write the polling loop and get the jobCode values wrong.
   * This is the path that pushes aggregation down: a GROUP BY over a million
   * rows is answered in a few hundred bytes.
   *
   * Pass 'sql' for a statement you wrote, or the spec fields (table, columns,
   * metrics, filters, groupBy, orderBy, limit) to have one built with every
   * identifier and literal quoted correctly.
   */
  async query(options = {}) {
    const {
      workspaceId, sql, format = 'json', pollMs = 1000, timeoutMs = 50000,
      tableCriteriaList,
    } = options;

    if (!workspaceId) throw new Error('data.query needs a workspaceId.');
    const statement = sql ?? __buildSql(options);
    if (!/^\s*select\b/i.test(statement)) {
      throw new Error('Only SELECT statements are allowed (the server answers 7402 otherwise). '
        + 'Got: ' + statement.slice(0, 80));
    }

    const config = { responseFormat: format, sqlQuery: statement };
    if (options.selectedColumns) config.selectedColumns = options.selectedColumns;
    // Documented, but measured live as silently ignored — a filter naming a
    // table the statement does not reference returned 200 and unfiltered rows
    // where 7836 is documented. Only sent when a caller asks for it, and the
    // caveat travels with the result.
    if (tableCriteriaList) config.tableCriteriaList = tableCriteriaList;

    const started = Date.now();
    const created = await za.createExportJobSQLQuery({
      'ZANALYTICS-ORGID': ORG_ID,
      'workspace-id': String(workspaceId),
      CONFIG: JSON.stringify(config),
    });

    const jobId = created?.data?.jobId ?? created?.jobId;
    if (!jobId) {
      throw new Error('The export job was not created: ' + JSON.stringify(created).slice(0, 300));
    }

    const result = await data.awaitJob(workspaceId, jobId, { pollMs, timeoutMs, format });
    return {
      ...result,
      sql: statement,
      pushdown: {
        sql: statement,
        tableCriteriaList: tableCriteriaList
          ? 'sent, but measured as ignored by the server — keep row selection in the WHERE clause'
          : null,
      },
      ms: Date.now() - started,
    };
  },

  /**
   * Poll an export job to completion and download it.
   *
   * Shared by data.query() and data.export(), and usable on its own for a job
   * created some other way. jobCode is the authority ("1004" is done); the
   * human jobStatus is only a fallback for a deployment that omits the code.
   *
   * There is NO SLEEP in this loop, because there is no timer to sleep with:
   * the isolate has no setTimeout, and reaching for one is a ReferenceError
   * deep inside a polling loop - a failure that reads as "the export broke".
   * The pacing happens on the host instead, which spaces consecutive status
   * calls for the same job by ZA_JOB_POLL_INTERVAL_MS. The isolate blocks on
   * every call anyway - the tool bridge is synchronous from in here - so the
   * host's wait IS this loop's wait. maxPolls bounds the loop in calls and
   * the deadline bounds it in time.
   */
  async awaitJob(workspaceId, jobId, { pollMs = 1000, timeoutMs = 50000, format = 'json' } = {}) {
    const deadline = Date.now() + timeoutMs;
    const maxPolls = Math.max(2, Math.ceil(timeoutMs / Math.max(pollMs, 100)));
    let polls = 0;
    let last = null;

    for (;;) {
      const details = await za.getExportJobDetails({
        'ZANALYTICS-ORGID': ORG_ID,
        'workspace-id': String(workspaceId),
        'job-id': String(jobId),
      });
      polls += 1;
      last = details?.data ?? details ?? {};
      const code = String(last.jobCode ?? '');
      const text = String(last.jobStatus ?? '');

      if (code === '1004' || /COMPLETED/i.test(text)) break;
      if (code === '1003' || /ERROR/i.test(text)) {
        throw new Error('The export job failed (jobCode 1003): '
          + (last.errorMessage ?? JSON.stringify(last).slice(0, 300)));
      }
      if (code === '1005' || /NOT FOUND/i.test(text)) {
        throw new Error('Export job ' + jobId + ' does not exist (jobCode 1005).');
      }
      if (Date.now() > deadline || polls >= maxPolls) {
        throw new Error('The export job was still running after ' + polls + ' polls, last '
          + 'status "' + (text || code) + '". Narrow the query, or pick the file up later '
          + 'with data.awaitJob(' + JSON.stringify(String(workspaceId)) + ', '
          + JSON.stringify(String(jobId)) + ').');
      }
    }

    const downloaded = await za.downloadExportedData({
      'ZANALYTICS-ORGID': ORG_ID,
      'workspace-id': String(workspaceId),
      'job-id': String(jobId),
    });

    if (format !== 'json') {
      return { jobId: String(jobId), polls, format, body: downloaded?.data ?? downloaded };
    }
    // The download has no status envelope: the body is {"data": [...]}.
    const list = rows.of(downloaded);
    return { jobId: String(jobId), polls, rows: list, rowCount: list.length };
  },

  /**
   * Asynchronous export of a whole view, with the same pushdown.
   *
   * The synchronous export refuses tables over a million rows, live-connect
   * workspaces, dashboards and query tables. This is the path for those, and
   * it takes 'criteria' and 'selectedColumns' exactly the same way.
   */
  async export(options = {}) {
    const {
      workspaceId, viewId, filters, criteria, filterJoin, columns,
      format = 'json', pollMs = 1000, timeoutMs = 50000, validate = true,
    } = options;

    if (!workspaceId || !viewId) throw new Error('data.export needs workspaceId and viewId.');

    let expression = __where(filters ?? criteria, filterJoin);
    if (expression && validate) {
      expression = await data.checkCriteria(workspaceId, viewId, expression);
    }

    const config = { responseFormat: format };
    if (expression) config.criteria = expression;
    if (columns && columns.length) config.selectedColumns = columns;
    if (options.config) Object.assign(config, options.config);

    const started = Date.now();
    const created = await za.createExportJobViewId({
      'ZANALYTICS-ORGID': ORG_ID,
      'workspace-id': String(workspaceId),
      'view-id': String(viewId),
      CONFIG: JSON.stringify(config),
    });
    const jobId = created?.data?.jobId ?? created?.jobId;
    if (!jobId) {
      throw new Error('The export job was not created: ' + JSON.stringify(created).slice(0, 300));
    }

    const result = await data.awaitJob(workspaceId, jobId, { pollMs, timeoutMs, format });
    return {
      ...result,
      pushdown: { criteria: expression || null, selectedColumns: columns ?? null },
      ms: Date.now() - started,
    };
  },

  /**
   * How many rows match, without fetching any of them.
   *
   * 32 bytes against the live API where the equivalent export was 130 KB.
   * Worth calling before any wide read: it turns "is this going to be huge"
   * from a guess into a number.
   */
  async count(options = {}) {
    const { workspaceId, table } = options;
    const out = await data.query({
      workspaceId,
      table,
      metrics: [{ fn: 'count', column: '*', as: 'rowCount' }],
      filters: options.filters ?? options.where,
      filterJoin: options.filterJoin,
    });
    const value = rows.num(out.rows?.[0]?.rowCount ?? out.rows?.[0]?.['count(*)']);
    // Carry the pushdown forward: a count that does not say it ran as SQL
    // reads, to the caller, like a view export that returned one number.
    return { rowCount: value, sql: out.sql, polls: out.polls, pushdown: out.pushdown };
  },

  /**
   * Group and aggregate inside Analytics.
   *
   * The one call that replaces "download everything, then reduce in JS". Both
   * produce the same numbers; only one of them puts the rows in the model's
   * context.
   */
  async aggregate(options = {}) {
    const metrics = options.metrics ?? [{ fn: 'sum', column: options.measure }];
    return data.query({ ...options, metrics, groupBy: options.groupBy ?? options.by });
  },

  /**
   * A few rows to look at, the way the MCP server's preview does.
   *
   * Deliberately capped: the purpose is to learn the shape and the value
   * formatting, and twenty rows show that as well as twenty thousand.
   *
   * The limit is pushed into a SQL LIMIT when the view can be named in a
   * SELECT AND the table is big enough for that to be worth three calls. On a
   * million-row table the difference is indefensible the other way: a
   * five-row preview through the view export moves every row and throws all
   * but five away, at three billed units per thousand.
   *
   * On a SMALL table it is the reverse. Export units are billed per thousand
   * rows produced, so a 755-row export and a 5-row export cost the same one
   * block — and the view export gets there in a single call where the job
   * needs four. Previewing a small table through SQL was paying three extra
   * round trips for a saving the billing does not grant.
   *
   * On a view SQL cannot name - a chart, pivot or summary - the view export
   * is the only route, and the result then says the rows were dropped after
   * download rather than never produced.
   */
  async preview(options = {}) {
    const { workspaceId, viewId, limit = 20 } = options;
    const detail = viewId ? await data.view(workspaceId, viewId) : null;

    if (detail && data.sqlAddressable(detail.viewType) && (data.isLarge(detail) || !viewId)) {
      const out = await data.query({
        ...options,
        workspaceId,
        table: options.table ?? detail.viewName,
        limit,
      });
      const sample = out.rows ?? [];
      return {
        ...__columnar(sample),
        viewType: detail.viewType,
        sql: out.sql,
        pushdown: out.pushdown,
        note: 'Sample only, bounded inside Analytics. Do not total or count from it — '
          + 'use groupBy + metrics.',
      };
    }

    const out = await data.rows({ ...options, workspaceId, viewId, limit });
    const sample = out.rows ?? [];
    return {
      ...__columnar(sample),
      rowsAvailable: out.rowsAvailable,
      viewType: detail ? detail.viewType : null,
      pushdown: out.pushdown,
      note: out.truncated
        ? 'Sample only. All ' + out.rowsAvailable + ' rows were exported first — a '
          + (detail && detail.viewType ? detail.viewType : 'view') + ' has no SQL name '
          + 'and no limit attribute. Do not total from it.'
        : undefined,
    };
  },
};
`;
