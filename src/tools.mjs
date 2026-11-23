/**
 * The MCP tools, defined once and shared by both entrypoints.
 *
 * `resolve(extra)` returns the { catalog, search, orgId } for this call. The
 * stdio server always answers with the same one; the remote server answers
 * with the signed-in user's, keyed off their bearer token.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { renderSignatures } from './search.mjs';
import { DOMAINS, DISCOVERY } from './catalog.mjs';
import { buildProgram, capResult, describePushdown, validate } from './data-engine.mjs';

export function registerTools(server, resolve, {
  operationCount, domains, knowledge, audit, scope, limits,
}) {
  const domainList = domains?.length ? domains : Object.keys(DOMAINS);
  const caps = { maxRows: limits?.maxRows ?? 500, maxBytes: limits?.maxBytes ?? 120_000 };

  // -------------------------------------------------------------------------
  // 1. Find operations
  // -------------------------------------------------------------------------
  server.registerTool('search_analytics_api',
    {
      title: 'Search the Zoho Analytics API',
      description:
        'Find the Zoho Analytics operations relevant to a task and get their exact '
        + 'call signatures for run_analytics_code. The signatures are type-annotated to '
        + 'show argument shapes, but the code you write is plain JavaScript — do not copy '
        + 'the annotations. ALWAYS call this first: there '
        + `are ${operationCount} operations and you need the signatures before you can write `
        + 'code. Describe the operation you need in API terms rather than quoting the '
        + 'user — "export rows from a view with a filter" or "list users in an '
        + 'organization" work better than "how much did we sell".\n\n'
        + 'If the task is READING DATA — rows matching a filter, a total, a breakdown, '
        + 'a top-N, a row count — use query_analytics_data instead of searching for an '
        + 'export operation and writing the call yourself. It applies the filter, the '
        + 'column selection and the aggregation inside Analytics, which is where they '
        + `belong.\n\nDomains available: ${domainList.join(', ')}.`,
      inputSchema: {
        task: z.string().min(2).describe('The operation you need, in API vocabulary'),
        domain: z.enum(domainList).optional()
          .describe('Restrict the search to one API domain'),
        limit: z.number().int().min(1).max(25).optional()
          .describe('How many operations to return (default 8)'),
      },
    },
    async ({ task, domain, limit }, extra) => {
      const { search, orgId } = await resolve(extra);
      const found = await search.find(task, limit ?? 8, domain ?? null);

      if (!found.length) {
        return {
          content: [{
            type: 'text',
            text: `No operations matched "${task}"`
              + (domain ? ` in domain "${domain}"` : '')
              + '. Try API vocabulary: export, view, workspace, dashboard, report, table, '
              + 'column, row, user, share, schedule, alert, formula, import, query. '
              + `Domains: ${domainList.join(', ')}.`,
          }],
        };
      }

      // Point at the playbook before the model invents its own sequence.
      const hints = knowledge?.hintsFor(found) ?? [];
      const hintText = hints.length
        ? '\n\nBefore writing code, consider reading:\n'
          + hints.map((h) => `  get_analytics_guide("${h.id}")  — ${h.title}`).join('\n')
        : '';

      return {
        content: [{
          type: 'text',
          text: `${found.length} matching operations. Call them on the \`za\` object inside `
            + `run_analytics_code. \`ORG_ID\` is predefined there (${orgId}), so pass it as `
            + "`'ZANALYTICS-ORGID': ORG_ID`.\n\n"
            + renderSignatures(found) + hintText,
        }],
      };
    });

  // -------------------------------------------------------------------------
  // 2. Read the documentation
  // -------------------------------------------------------------------------
  if (knowledge) {
    const topics = knowledge.list();
    const workflows = topics.filter((t) => t.kind === 'workflow');
    const references = topics.filter((t) => t.kind === 'reference');

    server.registerTool('get_analytics_guide',
      {
        title: 'Read Zoho Analytics documentation',
        description:
          'Look up how something actually works before writing code — the criteria '
          + 'grammar, how CONFIG must be stringified, how an asynchronous export job '
          + 'is polled, what an error code means. Signatures tell you what to call; '
          + 'this tells you how to call it correctly.\n\n'
          + 'Pass a topic id, a plain-language question, or a four-digit error code.\n\n'
          + `Playbooks: ${workflows.map((t) => t.id).join(', ')}.\n`
          + `References: ${references.map((t) => t.id).join(', ')}.\n`
          + `Source: github.com/zoho/analytics-okf, OKF bundle `
          + `${knowledge.provenance.okfVersion ?? '?'} generated `
          + `${knowledge.provenance.okfGeneratedAt?.slice(0, 10) ?? 'an unknown date'}.`,
        inputSchema: {
          topic: z.string().min(1)
            .describe('A topic id, a question, or an error code such as 8080'),
        },
      },
      async ({ topic }) => {
        const trimmed = topic.trim();

        // An error code is an exact lookup, not a search.
        if (/^\d{4}$/.test(trimmed)) {
          const entry = knowledge.error(trimmed);
          if (entry) {
            return {
              content: [{
                type: 'text',
                text: `# Error ${trimmed}\n\n**Meaning:** ${entry.meaning}\n\n`
                  + `**Resolution:** ${entry.resolution ?? 'See the API reference.'}\n\n`
                  + `**HTTP status:** ${entry.http ?? 'unknown'}  \n`
                  + `**Retryable:** ${entry.retryable ? 'yes' : 'no — fix the request first'}`,
              }],
            };
          }
        }

        const exact = knowledge.byId(trimmed);
        if (exact) {
          return { content: [{ type: 'text', text: `# ${exact.title}\n\n${exact.body}` }] };
        }

        const [best] = knowledge.find(trimmed, 1);
        if (best) {
          const others = knowledge.find(trimmed, 4).slice(1).map((d) => d.id);
          return {
            content: [{
              type: 'text',
              text: `# ${best.title}\n\n${best.body}`
                + (others.length ? `\n\n---\nRelated topics: ${others.join(', ')}` : ''),
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `No guide matched "${topic}".\n\nPlaybooks:\n`
              + workflows.map((t) => `  ${t.id} — ${t.description}`).join('\n')
              + '\n\nReferences:\n'
              + references.map((t) => `  ${t.id} — ${t.description}`).join('\n'),
          }],
        };
      });
  }

  // -------------------------------------------------------------------------
  // 3. Find the user's actual data
  // -------------------------------------------------------------------------
  server.registerTool('find_analytics_objects',
    {
      title: 'Find workspaces, views and columns by name',
      description:
        "Resolve what the user MEANT into real IDs. People say \"my profit table\" "
        + 'when the table is called "Sales_Profit_by_Country", and they often name '
        + 'nothing at all. Use this BEFORE writing code whenever a workspace, view, '
        + 'table or column is referred to by name — never guess an ID and never '
        + 'hardcode a name into a filter.\n\n'
        + 'Searches workspaces, views, columns, variables, folders, groups, '
        + 'datasources and aggregate formulas. Everything except workspaces and views '
        + 'needs a workspaceId; columns also need a viewId.\n\n'
        + 'Call it with no query to list what exists. Matching is fuzzy and ranked: '
        + 'every result carries a score and why it matched, so you can tell a '
        + 'confident hit from a weak one. If nothing matches, the response lists what '
        + 'was searched — report that to the user rather than claiming their data '
        + 'does not exist.\n\n'
        + 'NEVER substitute. If the user names something and nothing matches it, stop '
        + 'and ask. Using a different variable, column or table than the one they '
        + 'named produces a confident wrong answer, which is the worst outcome here.',
      inputSchema: {
        query: z.string().optional()
          .describe('The name the user used. Omit to list everything available.'),
        kind: z.enum(['any', 'workspace', 'view', 'column',
          'variable', 'folder', 'group', 'datasource', 'formula']).optional()
          .describe('What to look for (default: any — resolves to a workspace and view)'),
        workspaceId: z.string().optional()
          .describe('Restrict to one workspace. Required for every kind except '
            + '"any", "workspace" and "view".'),
        viewId: z.string().optional().describe('Required when kind is "column".'),
      },
    },
    async ({ query, kind = 'any', workspaceId, viewId }, extra) => {
      const { catalog } = await resolve(extra);

      const WORKSPACE_SCOPED = ['column', 'variable', 'folder', 'group',
        'datasource', 'formula'];

      if (kind === 'column' && !(workspaceId && viewId)) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: 'Finding columns needs both workspaceId and viewId. Resolve the view '
              + 'first with kind "view" or "any".',
          }],
        };
      }

      if (WORKSPACE_SCOPED.includes(kind) && !workspaceId) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Finding a ${kind} needs a workspaceId — these live inside one `
              + 'workspace. Resolve the workspace first with kind "workspace".',
          }],
        };
      }

      const program =
        kind === 'workspace' ? DISCOVERY.workspaces(query)
        : kind === 'view' ? DISCOVERY.views(query, workspaceId)
        : kind === 'column' ? DISCOVERY.columns(query, workspaceId, viewId)
        : WORKSPACE_SCOPED.includes(kind) ? DISCOVERY.metadata(kind, query, workspaceId)
        : query ? DISCOVERY.resolve(query)
        : DISCOVERY.workspaces(null);

      const requestId = audit?.newRequest?.() ?? undefined;
      const discoveryActor = actorOf(await resolve(extra), extra);
      try {
        const { result, calls } = await catalog.execute(program,
          { requestId, actor: discoveryActor });
        return {
          content: [{ type: 'text', text: JSON.stringify({ ...result, apiCalls: calls }) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: explain(err, knowledge) }] };
      }
    });

  // -------------------------------------------------------------------------
  // 4. Read data, with the filter on the server
  // -------------------------------------------------------------------------
  server.registerTool('query_analytics_data',
    {
      title: 'Read Zoho Analytics data with server-side filtering',
      description:
        'Read rows or aggregates from a table, report or dashboard with the filtering, '
        + 'grouping and limiting done INSIDE Analytics, so only the answer crosses the '
        + 'wire. Use this instead of exporting a view and filtering the rows yourself — '
        + 'measured on a live 755-row table, the same question produced 128 KB of '
        + 'exported rows that way and 1.2 KB this way, and the gap grows with the '
        + 'table. Export units are billed per 1000 rows produced, so it is cheaper in '
        + 'quota as well as in context.\n\n'
        + 'Give it the narrowest request that answers the question:\n'
        + '  • `filters` — row selection, as [{ column, op, value }]. Operators: eq, ne, '
        + 'gt, gte, lt, lte, in, notIn, like, contains, startsWith, endsWith, between, '
        + 'isNull, notNull. Quoting is handled for you; never build the expression by '
        + 'hand.\n'
        + '  • `columns` — the columns you actually need.\n'
        + '  • `groupBy` + `metrics` — aggregate server-side. [{ fn: "sum", column: '
        + '"Sales" }] with groupBy ["Region"] returns one row per region, not the table.\n'
        + '  • `limit` / `orderBy` — top-N, pushed into the SQL.\n'
        + '  • `mode: "count"` — how many rows match, without fetching any.\n'
        + '  • `mode: "preview"` — twenty rows to see the shape and the value formatting.\n\n'
        + 'Resolve workspaceId and viewId with find_analytics_objects first — never guess '
        + 'an id, and never pass a name where an id belongs. Column names must be the '
        + "view's own display names; a filter naming a column the view does not have is "
        + 'refused with the list of real ones rather than silently dropped.\n\n'
        + 'This tool only reads. For anything it cannot express, use run_analytics_code — '
        + 'the same engine is available there as `data.*`.',
      inputSchema: {
        workspaceId: z.string().describe('Workspace id, from find_analytics_objects'),
        viewId: z.string().optional()
          .describe('View, table, report or dashboard id. Required unless you pass table or sql.'),
        table: z.string().optional()
          .describe('Table name for the SQL path, when you know it. Otherwise viewId is '
            + "resolved to the view's name."),
        sql: z.string().optional()
          .describe('A SELECT statement to run inside Analytics. Only use this when the '
            + 'structured fields cannot express the question; they quote identifiers for you.'),
        filters: z.array(z.object({
          column: z.string(),
          op: z.string().optional().describe('eq (default), ne, gt, gte, lt, lte, in, '
            + 'notIn, like, contains, startsWith, endsWith, between, isNull, notNull'),
          value: z.any().optional().describe('A value, or an array for in / between'),
          table: z.string().optional().describe('Qualify the column when the view joins tables'),
        })).optional().describe('Row selection, applied by the server'),
        filterJoin: z.enum(['and', 'or']).optional().describe('How to combine filters (default and)'),
        columns: z.array(z.string()).optional()
          .describe('Only these columns are exported'),
        groupBy: z.array(z.string()).optional().describe('Group the aggregate by these columns'),
        metrics: z.array(z.object({
          fn: z.enum(['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'stddev', 'variance'])
            .optional(),
          column: z.string().describe('Column to aggregate, or "*" for count'),
          as: z.string().optional().describe('Name for the result column'),
        })).optional().describe('Aggregates computed inside Analytics'),
        orderBy: z.array(z.object({
          column: z.string(),
          dir: z.enum(['asc', 'desc']).optional(),
        })).optional(),
        limit: z.number().int().min(1).max(10_000).optional()
          .describe('Maximum rows. Pushed into the SQL when the SQL path is used.'),
        offset: z.number().int().min(0).optional(),
        distinct: z.boolean().optional(),
        mode: z.enum(['auto', 'view', 'sql', 'count', 'preview']).optional()
          .describe('auto picks the view export for a plain filtered read and the SQL '
            + 'export job when the question needs SQL'),
        format: z.enum(['json', 'csv']).optional()
          .describe('csv is denser for many rows; json is easier to reason about'),
      },
    },
    async (request, extra) => {
      const session = await resolve(extra);
      const { catalog, orgId } = session;

      const { path, problems } = validate(request);
      if (problems.length) {
        return { isError: true, content: [{ type: 'text', text: problems.join('\n') }] };
      }

      const requestId = audit?.newRequest?.() ?? undefined;
      const actor = actorOf(session, extra);
      const started = Date.now();
      const program = buildProgram(request);

      try {
        const { result, logs, calls } = await catalog.execute(program, { requestId, actor });
        const { value, text, oversized } = capResult(result, caps);

        audit?.execution({
          requestId, actor, org: orgId, client: clientOf(extra),
          tool: 'query_analytics_data', scope: scope?.(session),
          code: program, outcome: 'ok', ms: Date.now() - started, apiCalls: calls,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...JSON.parse(text),
              path,
              // Say what ran on the server. Without this the model cannot tell
              // a small answer from a small table, so it never learns to push
              // the next filter down either.
              pushedDown: describePushdown(path, value),
              oversized,
              apiCalls: calls,
              logs: logs.length ? logs.slice(0, 20) : undefined,
            }),
          }],
        };
      } catch (err) {
        audit?.execution({
          requestId, actor, org: orgId, client: clientOf(extra),
          tool: 'query_analytics_data', scope: scope?.(session),
          code: program, outcome: 'error', ms: Date.now() - started, error: err?.message,
        });
        return { isError: true, content: [{ type: 'text', text: explain(err, knowledge) }] };
      }
    });

  // -------------------------------------------------------------------------
  // 5. Run the code
  // -------------------------------------------------------------------------
  server.registerTool('run_analytics_code',
    {
      title: 'Run code against Zoho Analytics',
      description:
        'Execute JavaScript against the Zoho Analytics API in a sandbox and return the '
        + 'result. Call search_analytics_api first for signatures, and '
        + 'get_analytics_guide if you are unsure how an operation behaves.\n\n'
        + 'PLAIN JavaScript only — the sandbox is a bare V8 isolate with no compiler, so '
        + 'TypeScript syntax is a syntax error. The signatures are type-annotated to show '
        + 'you the shape of each argument; do not copy the annotations into your code. No '
        + '`const x: number`, no `interface`, no `as` casts. Modern JavaScript is fine: '
        + 'async/await, optional chaining, destructuring.\n\n'
        + 'The sandbox provides one global, `za`, with every available operation as an '
        + 'async method, plus the `ORG_ID` constant. It has no network, no imports and '
        + 'no filesystem — `za` is the only way out.\n\n'
        + 'Three helpers are predefined. `find.*` turns a name into an id and refuses to '
        + 'guess. `rows.*` reads results safely (export rows arrive as a flat array, and '
        + 'values are formatted strings like "$1,682.39" that Number() turns into NaN). '
        + '`data.*` is the data engine — USE IT INSTEAD OF EXPORTING AND FILTERING:\n'
        + '  data.rows({ workspaceId, viewId, filters, columns })   server-side criteria\n'
        + '  data.query({ workspaceId, table, metrics, groupBy, filters, orderBy, limit })\n'
        + '  data.count({ workspaceId, table, filters })            how many match\n'
        + '  data.aggregate / data.preview / data.export / data.awaitJob\n'
        + 'Downloading a table and filtering it in JavaScript is the one pattern to '
        + 'avoid: it bills API units per 1000 rows exported and can exhaust the timeout '
        + 'on a large table. Push the filter down.\n\n'
        + 'Use loops, polling and aggregation freely, and `return` ONLY the final answer: '
        + 'keeping raw rows out of the response is the entire point — results are capped '
        + 'and a truncated one says so. Use console.log for progress notes. CONFIG '
        + "parameters must be JSON.stringify()'d strings.",
      inputSchema: {
        code: z.string().min(1)
          .describe('Plain JavaScript statements, no type annotations. Use await, and '
            + '`return` the final result.'),
      },
    },
    async ({ code }, extra) => {
      const session = await resolve(extra);
      const { catalog, orgId } = session;

      // One request id ties this execution to every API call it causes, so
      // the two streams join on `req`.
      const requestId = audit?.newRequest?.() ?? undefined;
      const actor = actorOf(session, extra);
      const started = Date.now();

      try {
        const { result, logs, calls } = await catalog.execute(code, { requestId, actor });
        audit?.execution({
          requestId, actor, org: orgId, client: clientOf(extra),
          tool: 'run_analytics_code', scope: scope?.(session),
          code, outcome: 'ok', ms: Date.now() - started, apiCalls: calls,
        });
        // A program is told to return only its answer, and nothing in the
        // sandbox can make it. The cap is the backstop, and it is loud: a
        // silently shortened list would be read as the whole of it.
        const capped = capResult(result, caps);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              result: capped.value,
              oversized: capped.oversized,
              logs: logs.slice(0, 50),
              apiCalls: calls,
            }),
          }],
        };
      } catch (err) {
        audit?.execution({
          requestId, actor, org: orgId, client: clientOf(extra),
          tool: 'run_analytics_code', scope: scope?.(session),
          code, outcome: 'error', ms: Date.now() - started, error: err?.message,
        });
        return { isError: true, content: [{ type: 'text', text: explain(err, knowledge, code) }] };
      }
    });

  return server;
}

/**
 * Who is asking.
 *
 * In remote mode the bearer token identifies the user, and it must never
 * reach a log — so it is hashed into a short, stable pseudonym that still
 * correlates every action by one person.
 */
function actorOf(session, extra) {
  const token = extra?.authInfo?.token;
  if (token) {
    return `user:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  }
  return session?.credentialSource ?? 'local';
}

/** Which MCP client made the call, when it tells us. */
function clientOf(extra) {
  const info = extra?.requestInfo?.headers ?? {};
  return {
    name: extra?.sessionId ? `session:${String(extra.sessionId).slice(0, 8)}` : undefined,
    ua: typeof info['user-agent'] === 'string' ? info['user-agent'].slice(0, 80) : undefined,
  };
}

/**
 * TypeScript syntax that a bare V8 isolate rejects.
 *
 * The signatures this server hands out are type-annotated, which reads as an
 * invitation to write TypeScript — but there is no compiler anywhere in the
 * chain, so `const n: number = 1` dies as "Missing initializer in const
 * declaration" and an `as` cast as "Unexpected identifier 'as'". Neither
 * message mentions types, so the model has no way to work out what it did.
 */
const TS_SYNTAX = [
  [/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$]/, 'a type annotation on a variable'],
  [/\binterface\s+[A-Za-z_$][\w$]*\s*\{/, 'an `interface` declaration'],
  [/\s+as\s+(?:string|number|boolean|any|unknown|never|[A-Za-z_$][\w$]*\s*\[\])\b/, 'an `as` cast'],
  [/\btype\s+[A-Za-z_$][\w$]*\s*=/, 'a `type` alias'],
  [/\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*:\s*[A-Za-z_$]/, 'a typed function parameter'],
  [/\benum\s+[A-Za-z_$][\w$]*\s*\{/, 'an `enum` declaration'],
];

/** Turn an execution failure into something the model can act on. */
export function explain(err, knowledge, code) {
  const message = String(err?.message ?? err);
  const hints = [];

  // Checked first: a syntax error from a type annotation explains every other
  // symptom, and the raw V8 message actively misdirects.
  if (code && /SyntaxError|Unexpected identifier|Missing initializer|Unexpected token/i.test(message)) {
    const found = TS_SYNTAX.filter(([re]) => re.test(code)).map(([, what]) => what);
    if (found.length) {
      hints.push(
        `The sandbox runs PLAIN JavaScript, not TypeScript — there is no compiler. `
        + `Your program contains ${found.join(' and ')}. Remove the type syntax and `
        + 'run it again; the signatures are annotated only to show argument shapes.');
    }
  }

  // Any Zoho error code in the message gets its documented meaning attached,
  // straight from the OKF catalog.
  for (const entry of knowledge?.explainCodes(message) ?? []) {
    hints.push(`Error ${entry.code}: ${entry.meaning}`
      + (entry.resolution ? ` — ${entry.resolution}` : '')
      + (entry.retryable ? ' (retryable)' : ''));
  }

  if (/is not a function/.test(message)) {
    hints.push('That operation is not available. Call search_analytics_api to get exact '
      + 'names — they are case-sensitive, write operations are hidden unless the server '
      + 'enables them, and this deployment may serve only some API domains.');
  }
  if (/budget exhausted/.test(message)) {
    hints.push('Narrow the task — filter server-side rather than fetching everything and '
      + 'filtering in code. data.rows({ workspaceId, viewId, filters, columns }) applies '
      + 'the filter in Analytics; data.query({ table, metrics, groupBy }) aggregates '
      + 'there. See get_analytics_guide("filter-criteria-syntax").');
  }
  if (/timed out|timeout/i.test(message)) {
    hints.push('Long exports should use the asynchronous job operations — data.export() '
      + 'and data.query() already do, including the polling. See '
      + 'get_analytics_guide("export-data-asynchronously").');
  }
  for (const [code, advice] of [
    ['7330', 'The filter names a column the view does not have. data.columns('
      + 'workspaceId, viewId) lists the real ones, and data.rows() checks them before '
      + 'the call.'],
    ['7331', 'Criteria quoting: double quotes around column names, single quotes around '
      + 'string literals. Pass structured filters to data.rows() and it quotes for you.'],
    ['7402', 'Only SELECT statements are accepted by the SQL export. This server reads '
      + 'data; it does not change it through SQL.'],
    ['7806', 'The XLS cell limit was exceeded. Narrow with filters or columns, or export '
      + 'as csv.'],
  ]) {
    if (message.includes(code)) hints.push(advice);
  }

  return `Execution failed: ${message}` + (hints.length ? `\n\n${hints.join('\n')}` : '');
}
