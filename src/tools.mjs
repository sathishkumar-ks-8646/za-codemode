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

export function registerTools(server, resolve, {
  operationCount, domains, knowledge, audit, scope,
}) {
  const domainList = domains?.length ? domains : Object.keys(DOMAINS);

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
        + `organization" work better than "how much did we sell".\n\nDomains available: `
        + `${domainList.join(', ')}.`,
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
  // 4. Run the code
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
        + 'Use loops, polling and aggregation freely, and `return` ONLY the final answer: '
        + 'keeping raw rows out of the response is the entire point. Use console.log for '
        + "progress notes. CONFIG parameters must be JSON.stringify()'d strings.",
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
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ result, logs: logs.slice(0, 50), apiCalls: calls }),
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
    hints.push('Narrow the task — filter server-side with CONFIG criteria rather than '
      + 'fetching everything and filtering in code. See get_analytics_guide('
      + '"filter-criteria-syntax").');
  }
  if (/timed out|timeout/i.test(message)) {
    hints.push('Long exports should use the asynchronous job operations. See '
      + 'get_analytics_guide("export-data-asynchronously").');
  }

  return `Execution failed: ${message}` + (hints.length ? `\n\n${hints.join('\n')}` : '');
}
