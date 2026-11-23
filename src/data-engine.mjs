/**
 * The host side of the data engine: routing, and a cap on what comes back.
 *
 * The engine itself lives in the sandbox (src/sandbox-data.mjs) so that
 * model-written code and the `query_analytics_data` tool share one
 * implementation of criteria quoting, SQL building and job polling. What is
 * left here is the part that cannot run inside the isolate:
 *
 *  - choosing between the view export and the SQL export job from the shape
 *    of a request, which is a decision the tool makes before any code runs;
 *  - turning a validated request into the program that runs it, exactly the
 *    way DISCOVERY does, so auth, pacing, the call budget and the audit trail
 *    are identical for a tool call and for generated code;
 *  - capping the result, which must happen outside the sandbox because the
 *    point of the cap is to protect the model's context and a program is free
 *    to return whatever it likes.
 */

/**
 * Which export path answers this request.
 *
 * The two are not interchangeable:
 *
 *   view  — GET .../views/{id}/data, one call, rows straight back. Honours
 *           criteria and selectedColumns. No row limit attribute, no
 *           aggregation, and the server refuses it for tables over a million
 *           rows, live-connect workspaces and dashboards.
 *   sql   — the bulk export job, three calls. Everything a SELECT can do:
 *           WHERE, GROUP BY, aggregates, ORDER BY, LIMIT. Costs two extra
 *           round trips, which only pays when it removes rows.
 *
 * So: anything that needs real SQL goes to the job, and a plain filtered read
 * stays on the single call. A `limit` on its own is interesting — pushing it
 * down turns three calls into a guaranteed-small answer, which is worth it
 * once the table is big, and the caller is told when that applies.
 */
export function choosePath(request) {
  if (request.mode && request.mode !== 'auto') return request.mode;
  if (request.sql) return 'sql';
  if (request.metrics?.length || request.groupBy?.length) return 'sql';
  if (request.orderBy?.length) return 'sql';
  if (request.distinct) return 'sql';
  if (request.limit && !request.viewId) return 'sql';
  if (!request.viewId && request.table) return 'sql';
  return 'view';
}

/** Reasons a request cannot be answered, in the words of what to do instead. */
export function validate(request) {
  const problems = [];
  const path = choosePath(request);

  if (!request.workspaceId) {
    problems.push('workspaceId is required. Find it with find_analytics_objects.');
  }

  if (path === 'view' && !request.viewId) {
    problems.push('Reading a view needs viewId. Find it with find_analytics_objects, '
      + 'or switch to the SQL path by naming a table.');
  }

  if (path === 'sql' && !request.sql && !request.table && !request.viewId) {
    problems.push('A SQL read needs either sql, or table, or viewId (whose name is '
      + 'looked up and used as the table).');
  }

  if (path === 'count' && !request.table && !request.viewId) {
    problems.push('Counting needs a table or a viewId.');
  }

  if (request.sql && !/^\s*select\b/i.test(request.sql)) {
    problems.push('Only SELECT statements are accepted; the server answers 7402 for '
      + 'anything else. This tool reads data, it never changes it.');
  }

  if (request.metrics?.length && !request.groupBy?.length && request.columns?.length) {
    problems.push('Mixing plain columns with aggregates needs them in groupBy. Move '
      + `${request.columns.join(', ')} into groupBy, or drop the aggregate.`);
  }

  return { path, problems };
}

/**
 * The program that answers the request.
 *
 * Built as source rather than called directly because the sandbox is the only
 * place with a `za` binding, and routing a tool call through it keeps one
 * audit trail and one call budget. Every value is JSON-encoded into the
 * program, so nothing a caller sends is ever concatenated into SQL or into a
 * criteria expression as text — the builders in the prelude do that, with
 * quoting.
 */
export function buildProgram(request) {
  const { path } = validate(request);
  const spec = {
    workspaceId: String(request.workspaceId),
    viewId: request.viewId ? String(request.viewId) : undefined,
    table: request.table,
    sql: request.sql,
    filters: request.filters?.length ? request.filters : undefined,
    criteria: request.criteria,
    filterJoin: request.filterJoin,
    columns: request.columns?.length ? request.columns : undefined,
    metrics: request.metrics?.length ? request.metrics : undefined,
    groupBy: request.groupBy?.length ? request.groupBy : undefined,
    orderBy: request.orderBy?.length ? request.orderBy : undefined,
    distinct: request.distinct || undefined,
    limit: request.limit,
    offset: request.offset,
    format: request.format === 'csv' ? 'csv' : 'json',
  };
  const literal = JSON.stringify(spec);

  if (path === 'count') {
    return `const spec = ${literal};
      if (!spec.table) spec.table = await data.tableFor(spec.workspaceId, spec.viewId);
      return await data.count(spec);`;
  }

  if (path === 'preview') {
    return `const spec = ${literal};
      return await data.preview({ ...spec, limit: spec.limit ?? 20 });`;
  }

  if (path === 'sql') {
    // Two things cannot be decided here, before any call: the view's NAME,
    // which SQL needs because it has no notion of ids, and whether SQL can
    // name this view at all. A chart, pivot, summary or dashboard answers
    // 7409 — "the table does not exist in this workspace" — which reads as a
    // missing object rather than as the wrong route. So the program asks
    // first, and on those views falls back to the view export with criteria,
    // where the view's own aggregation does the work and says so.
    return `const spec = ${literal};
      if (!spec.sql && !spec.table) {
        const view = await data.view(spec.workspaceId, spec.viewId);
        if (!data.sqlAddressable(view.viewType)) {
          const out = await data.rows({ ...spec, limit: spec.limit });
          return { ...out, path: 'view',
            sqlNotPossible: 'A ' + view.viewType + ' cannot be named in a SELECT, so the '
              + 'grouping, ordering and limit could not be pushed down. The filter was, '
              + 'and the view applies its own aggregation. For raw-row SQL, query the '
              + 'table underneath it instead.' };
        }
        spec.table = view.viewName;
      }
      return await data.query(spec);`;
  }

  // The asynchronous view export is the fallback when the synchronous one
  // refuses the view — a dashboard, a query table, a live-connect workspace or
  // a table over a million rows. Trying the cheap path first and falling back
  // costs one wasted call in the rare case and saves two in the common one.
  return `const spec = ${literal};
    try {
      return await data.rows(spec);
    } catch (err) {
      if (/\\b(7806|7807|8017|8088|restricted|not supported)\\b/i.test(String(err && err.message))) {
        console.log('synchronous export refused this view; retrying as an export job');
        return { ...(await data.export(spec)), fellBackTo: 'export job' };
      }
      throw err;
    }`;
}

/**
 * Trim a result to something a model can read without drowning in it.
 *
 * The server-side pushdown is what makes answers small; this is the backstop
 * for when it was not used, or was not enough. It truncates to valid JSON and
 * says what it dropped and how to ask for less, because a silently shortened
 * list is a wrong answer — the model would reason over 200 of 50,000 rows
 * believing it had them all.
 *
 * Two shapes carry rows: a bare array, and an object with a `rows` array.
 * Anything else is passed through untouched unless it is simply too big, in
 * which case it is reported rather than mangled — cutting a scalar in half
 * produces a plausible wrong number, which is worse than an oversized answer.
 */
export function capResult(value, { maxRows = 500, maxBytes = 120_000 } = {}) {
  const bare = Array.isArray(value);
  const list = bare ? value : (Array.isArray(value?.rows) ? value.rows : null);
  const rewrap = (rows, extra) => (bare ? rows : { ...value, rows, ...extra });

  if (list === null) {
    const text = JSON.stringify(value ?? null);
    if (text.length <= maxBytes) return { value, text, truncated: false };
    return {
      value,
      text,
      truncated: false,
      oversized: `The result is ${text.length} bytes, over the ${maxBytes}-byte budget, `
        + 'and holds no row list to trim. Return an aggregate rather than raw content.',
    };
  }

  const notes = [];
  let keep = list.length;
  if (keep > maxRows) {
    keep = maxRows;
    notes.push(`Showing ${maxRows} of ${list.length} rows (ZA_MAX_RESULT_ROWS). `
      + 'Narrow with filters, fewer columns, an aggregate, or a SQL LIMIT — '
      + 'do not reason about the rest from this sample.');
  }

  let out = keep < list.length
    ? rewrap(list.slice(0, keep), { rowsOmitted: list.length - keep })
    : value;
  let text = JSON.stringify(out ?? null);

  if (text.length > maxBytes && keep > 1) {
    while (keep > 1 && text.length > maxBytes) {
      keep = Math.max(1, Math.floor(keep / 2));
      out = rewrap(list.slice(0, keep), { rowsOmitted: list.length - keep });
      text = JSON.stringify(out);
    }
    notes.push(`Result exceeded ${maxBytes} bytes, cut to ${keep} `
      + `${keep === 1 ? 'row' : 'rows'} (ZA_MAX_RESULT_BYTES). `
      + 'Aggregate server-side instead of reading rows.');
  }

  if (notes.length) {
    const note = notes.join(' ');
    out = bare
      ? { rows: list.slice(0, keep), rowsOmitted: list.length - keep,
        truncated: true, truncation: note }
      : { ...out, truncated: true, truncation: note };
    text = JSON.stringify(out);
  }

  return { value: out, text, truncated: notes.length > 0 };
}

/**
 * What the request saved, in the units that matter.
 *
 * Reported on every answer because the saving is invisible otherwise: the
 * model sees a small result and has no way to know whether that is because
 * the table is small or because the filter ran on the server. Saying so is
 * what teaches the next call to do the same.
 */
export function describePushdown(path, result) {
  const bits = [];
  const p = result?.pushdown ?? {};
  if (p.criteria) bits.push(`criteria applied by the server: ${p.criteria}`);
  if (p.selectedColumns?.length) bits.push(`columns limited to ${p.selectedColumns.join(', ')}`);
  if (p.sql) bits.push(`SQL run inside Analytics: ${p.sql}`);
  if (p.limitAppliedBy === 'client') {
    bits.push('the row limit was applied after download — the synchronous view export has no '
      + 'limit attribute, so use the SQL path (give a table and a limit) to push it down');
  }
  if (p.tableCriteriaList) bits.push(`tableCriteriaList: ${p.tableCriteriaList}`);
  if (!bits.length) {
    bits.push(path === 'sql'
      ? 'ran as a SQL export job'
      : 'read the whole view — add filters, columns or an aggregate to narrow it server-side');
  }

  // A pushdown that still returns hundreds of rows has narrowed the export
  // but not the context. Saying so is what turns the next call into an
  // aggregate rather than a second wide read.
  const returned = Array.isArray(result?.rows) ? result.rows.length : 0;
  if (returned >= WIDE_RESULT_ROWS) {
    bits.push(`${returned} rows still reached the model — if the question is a total, a `
      + 'count or a ranking, ask for groupBy + metrics and get it in a few rows instead');
  }

  return bits.join('; ');
}

/**
 * Where "narrowed" stops meaning "small".
 *
 * Measured: 207 rows of a seven-column sales table is 35 KB of JSON, which is
 * a real share of a context window for an answer that was probably one number.
 */
const WIDE_RESULT_ROWS = 100;
