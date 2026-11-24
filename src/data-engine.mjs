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
 *           round trips, which buy a bounded result.
 *
 * SQL is the stronger instrument and the default wherever it can express the
 * question, because the thing being economised is not round trips — it is
 * rows. Export units are billed per 1000 rows PRODUCED, and rows that reach
 * the model are the scarcest resource of all. Three small calls beat one call
 * that moves a table.
 *
 * The one case the view export still wins is a read small enough that SQL's
 * two extra round trips buy nothing: no aggregate, no ordering, no limit, and
 * a table the server has already told us is small. That judgement needs the
 * row count, which is not knowable before the metadata call — so `auto` is
 * resolved in two stages. This function picks from the SHAPE of the request;
 * `refinePath` below revises it once the view's size and type are known.
 */
export function choosePath(request) {
  if (request.mode && request.mode !== 'auto') return request.mode;
  if (request.sql) return 'sql';
  if (request.metrics?.length || request.groupBy?.length) return 'sql';
  if (request.orderBy?.length) return 'sql';
  if (request.distinct) return 'sql';
  // A limit or an offset is a bounded read, and bounding it server-side is
  // the entire difference between 1.9 KB and 128 KB. Previously this applied
  // only when no viewId was given, which excluded the common case.
  if (request.limit || request.offset) return 'sql';
  if (!request.viewId && request.table) return 'sql';
  return 'view';
}

/**
 * Where "small enough to just read" ends.
 *
 * Measured on a live organization: a 755-row, seven-column table is 128 KB
 * exported whole. At 170 bytes per row, a thousand rows is the point where
 * one unbounded call stops being cheaper than three bounded ones — above it
 * the export is producing rows nobody asked for, and billing for them.
 */
export const SMALL_TABLE_ROWS = 1000;

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

const REFUSE_DASHBOARD = `
        throw new Error('STOPPED: "' + view.viewName + '" is a ' + view.viewType
          + ', which has no row data to read — measured live, both the synchronous '
          + 'export and the export job answer 8119 for one. A dashboard renders views; '
          + 'it does not tabulate. Query the tables or reports it is built from, which '
          + 'find.viewsIn(workspaceId) will list.');`;

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
export function buildProgram(request, { maxRows = 500 } = {}) {
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
  // An OFFSET with no LIMIT is not portable SQL, and an unbounded read is
  // what this engine exists to prevent anyway. Bounding it at the result cap
  // changes nothing the caller could have seen — anything past the cap was
  // going to be trimmed — while stopping the server producing and billing for
  // rows that would then be thrown away.
  if (spec.offset && !spec.limit) spec.limit = maxRows;
  const literal = JSON.stringify(spec);
  const cap = JSON.stringify(maxRows);

  if (path === 'count') {
    // Counting is a SELECT, so it needs a view a SELECT can name. On a chart
    // or pivot it cannot, and the honest count is of the rows that view
    // actually produces — which the view export returns, with the criteria
    // applied. Previously this path answered 7409.
    return `const spec = ${literal};
      if (!spec.table) {
        const view = await data.meta(spec.workspaceId, spec.viewId);
        if (!data.exportable(view.viewType)) { ${REFUSE_DASHBOARD} }
        if (!data.sqlAddressable(view.viewType)) {
          const out = await data.rows({ ...spec, columns: undefined });
          return { rowCount: out.rowCount, path: 'view', pushdown: out.pushdown,
            countedBy: 'A ' + view.viewType + ' cannot be named in a SELECT, so the rows '
              + 'it produces were counted after export rather than by count(*).' };
        }
        spec.table = view.viewName;
      }
      return { ...(await data.count(spec)), path: 'count' };`;
  }

  if (path === 'preview') {
    return `const spec = ${literal};
      const view = spec.viewId ? await data.meta(spec.workspaceId, spec.viewId) : null;
      if (view && !data.exportable(view.viewType)) { ${REFUSE_DASHBOARD} }
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
        const view = await data.meta(spec.workspaceId, spec.viewId);
        if (!data.exportable(view.viewType)) { ${REFUSE_DASHBOARD} }
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
      // A SELECT with no aggregate and no limit is an unbounded read wearing
      // a SELECT. Cap it at what the result cap would keep anyway, so the
      // server never produces — or bills for — rows that cannot be returned.
      if (!spec.sql && !spec.metrics && !spec.groupBy && !spec.limit) {
        spec.limit = ${cap} + 1;
        spec.cappedForSafety = true;
      }
      const out = { ...(await data.query(spec)), path: 'sql' };
      return spec.cappedForSafety
        ? { ...out, safetyLimit: 'No limit was given, so the SELECT was bounded at '
            + (${cap} + 1) + ' rows — the most a result can carry. Ask for an aggregate '
            + 'if you need to reason about more than that.' }
        : out;`;
  }

  // The plain filtered read. One call, rows straight back — but only when the
  // read is actually small. The metadata call that resolves the view also
  // reports its row count, so "is this worth bounding with SQL" is answerable
  // before a single row moves, and for free.
  return `const spec = ${literal};
    const view = spec.viewId ? await data.meta(spec.workspaceId, spec.viewId) : null;
    if (view && !data.exportable(view.viewType)) { ${REFUSE_DASHBOARD} }
    if (view && data.sqlAddressable(view.viewType) && data.isLarge(view)) {
      // Big enough that exporting it whole would produce rows the cap throws
      // away. SQL bounds it at the source instead.
      const out = await data.query({ ...spec, table: view.viewName, limit: ${cap} + 1 });
      return { ...out, path: 'sql',
        routedToSql: 'This ' + view.viewType + ' holds ' + view.rowCount + ' rows, so the '
          + 'read was bounded with SQL rather than exported whole. Add an aggregate or a '
          + 'filter to answer over all of them.' };
    }
    try {
      return await data.rows(spec);
    } catch (err) {
      if (/\\b(7806|7807|8017|8088|8133)\\b|restricted|not supported|not allowed|switch to async/i
          .test(String(err && err.message))) {
        console.log('synchronous export refused this view; retrying as an export job');
        return { ...(await data.export(spec)), fellBackTo: 'export job' };
      }
      throw err;
    }`;
}

/**
 * Strip a result down to the answer.
 *
 * "Total sales for the West" is one row and about forty bytes of answer. It
 * used to cost 563, and almost none of the difference was the answer: the
 * statement was carried three times — as `sql`, again inside `pushdown.sql`,
 * and a third time spelled out inside `pushedDown` — beside a job id, a poll
 * count and a millisecond timing that no model has ever needed to answer a
 * question. The same call is now 212 bytes.
 *
 * So the envelope is now: the rows, what they are, the statement ONCE, and
 * anything the server did that the statement does not already show. The
 * diagnostics still exist — they go to the audit stream, which is where
 * something written for an operator belongs.
 */
const DIAGNOSTIC_FIELDS = ['jobId', 'polls', 'ms', 'pushdown'];

export function leanResult(value, { path, apiCalls }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { result: value, path, apiCalls };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DIAGNOSTIC_FIELDS.includes(k)) continue;
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  // What the server applied, shown ONCE and as the thing itself rather than
  // as a sentence about it: `sql` on the SQL path, `criteria` on the view
  // path. A model can read either back and reason about it; prose describing
  // a statement that is also printed verbatim is pure duplication.
  const applied = value.pushdown ?? {};
  if (applied.criteria && !out.sql) out.criteria = applied.criteria;
  // How many matched, but only when it is not simply how many came back.
  if (out.rowsAvailable === out.rowCount) delete out.rowsAvailable;
  out.path = path;

  // `pushedDown` is now only what the fields CANNOT show: a window applied
  // after download, a result still too wide to reason over, a caveat about
  // something the server ignored.
  const advice = adviseOn(value);
  if (advice) out.pushedDown = advice;
  out.apiCalls = apiCalls;
  return out;
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

  // CSV arrives as one string in `body`, so it carries no row list to trim
  // and used to pass both caps untouched — while the tool description
  // recommended it as "denser for many rows". Denser is exactly what makes it
  // dangerous: the same budget buys more rows, and all of them land in the
  // context. It is trimmed on a line boundary so the remainder stays parseable.
  if (list === null && typeof value?.body === 'string' && value.body.length > maxBytes) {
    const lines = value.body.split('\n');
    const kept = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > maxBytes) break;
      kept.push(line);
      used += line.length + 1;
    }
    // Always keep the header, even if it alone is over budget — a CSV body
    // with no header is not shorter, it is unreadable.
    if (kept.length < 2) kept.splice(0, kept.length, lines[0] ?? '');
    const out = {
      ...value,
      body: kept.join('\n'),
      rowsOmitted: Math.max(0, lines.length - kept.length),
      truncated: true,
      truncation: `The CSV was ${value.body.length} bytes, over the ${maxBytes}-byte `
        + `budget, and was cut to ${kept.length} lines (ZA_MAX_RESULT_BYTES). `
        + 'Narrow it server-side with filters, columns or an aggregate — do not '
        + 'reason about the rest from this fragment.',
    };
    return { value: out, text: JSON.stringify(out), truncated: true };
  }

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
  const advice = adviseOn(result);
  if (advice) bits.push(advice);
  if (!bits.length) {
    bits.push(path === 'sql'
      ? 'ran as a SQL export job'
      : 'read the whole view — add filters, columns or an aggregate to narrow it');
  }
  return bits.join('; ');
}

/**
 * Only the parts a model cannot read off the result itself.
 *
 * `sql` and `criteria` are printed verbatim beside the rows, so repeating
 * them in prose costs bytes and tells nobody anything. What is NOT visible
 * from the result is whether a window was honoured by the server or faked
 * after the download, and whether an answer this wide should have been an
 * aggregate — and both change what the next call should be.
 */
export function adviseOn(result) {
  const bits = [];
  const p = result?.pushdown ?? {};
  if (p.selectedColumns?.length) bits.push(`columns limited to ${p.selectedColumns.join(', ')}`);
  if (p.limitAppliedBy === 'client') {
    bits.push('limit applied after download (the view export has none) — pass a table to '
      + 'push it into SQL');
  }
  if (p.offsetAppliedBy === 'client') {
    bits.push('offset applied after download — every skipped row was still exported');
  }
  if (p.tableCriteriaList) bits.push(`tableCriteriaList: ${p.tableCriteriaList}`);

  // A pushdown that still returns hundreds of rows has narrowed the export
  // but not the context. Saying so is what turns the next call into an
  // aggregate rather than a second wide read.
  const returned = Array.isArray(result?.rows) ? result.rows.length : 0;
  if (returned >= WIDE_RESULT_ROWS) {
    bits.push(`${returned} rows reached the model — for a total, count or ranking ask for `
      + 'groupBy + metrics instead');
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
