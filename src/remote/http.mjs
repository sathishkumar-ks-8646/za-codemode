/**
 * The HTTP application: OAuth endpoints, the MCP endpoint, and health.
 *
 * Routes
 *   /.well-known/oauth-authorization-server   AS metadata (SDK)
 *   /.well-known/oauth-protected-resource     RS metadata (SDK)
 *   /authorize, /token, /register, /revoke    OAuth 2.1 (SDK + our provider)
 *   /auth/callback                            where Zoho sends the browser back
 *   /mcp                                      the MCP endpoint, bearer-protected
 *   /healthz                                  liveness
 *   /                                         a human landing page
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from
  '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from
  '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { registerTools } from '../tools.mjs';
import { scopesFor } from './zoho-oauth.mjs';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body, status = 200) {
  return { status, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 34rem;
         margin: 12vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; letter-spacing: -.01em; }
  code { font: .9em ui-monospace, monospace; background: color-mix(in oklab, Canvas 85%, CanvasText);
         padding: .15em .4em; border-radius: 3px; }
  .ok { border-left: 3px solid #1a7f4b; padding-left: 1rem; }
  .bad { border-left: 3px solid #c0392b; padding-left: 1rem; }
</style></head><body>${body}</body></html>` };
}

export function createApp({ config, provider, sessions, operationCount, knowledge,
  domainBreakdown = {} }) {
  const app = express();
  app.disable('x-powered-by');
  // `trust proxy: true` would let any client spoof X-Forwarded-For and bypass
  // the per-IP rate limiting the SDK applies to /authorize, /token and
  // /register. Trust exactly the number of proxies actually in front of us.
  app.set('trust proxy', config.trustProxyHops);

  const issuer = new URL(config.publicUrl);

  // ---- OAuth 2.1 endpoints, provided by the SDK --------------------------
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: issuer,
    baseUrl: issuer,
    resourceName: 'Zoho Analytics Code Mode',
    scopesSupported: scopesFor(config),
    serviceDocumentationUrl: new URL(
      'https://www.zoho.com/analytics/api/v2/zoho-analytics-mcp-server.html'),
  }));

  // ---- Where Zoho sends the browser back ---------------------------------
  app.get('/auth/callback', async (req, res) => {
    try {
      const redirectTo = await provider.handleZohoCallback({
        code: req.query.code, state: req.query.state, error: req.query.error,
      });
      res.redirect(redirectTo);
    } catch (err) {
      const { status, html } = page('Sign-in failed', `
        <h1>Sign-in failed</h1>
        <div class="bad"><p>${escapeHtml(err.message)}</p></div>
        <p>Close this window and try connecting again from your MCP client.</p>`, 400);
      res.status(status).type('html').send(html);
    }
  });

  // ---- The MCP endpoint ---------------------------------------------------
  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource`,
  });

  app.post('/mcp', requireAuth, express.json({ limit: '4mb' }), async (req, res) => {
    const token = req.auth?.token;
    try {
      const session = await sessions.for(token);

      // Stateless per request: each call carries its own bearer token, and the
      // expensive part (the user's catalog) is pooled separately.
      const server = new McpServer({ name: 'zoho-analytics-code-mode', version: '2.0.0' });
      registerTools(server, () => session, {
        operationCount, domains: config.domains, knowledge,
      });

      // Stateless: `sessionIdGenerator: undefined` lets each POST stand alone,
      // so a client need not replay `initialize` and we need not hold transport
      // state between requests. The expensive per-user state — the operation
      // catalog — is pooled separately and keyed by the bearer token.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => { transport.close(); server.close(); });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[mcp] ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  // GET and DELETE on /mcp are only meaningful for SSE streams, which this
  // deployment does not use; answer honestly rather than hanging the client.
  for (const method of ['get', 'delete']) {
    app[method]('/mcp', requireAuth, (_req, res) => {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'This server uses JSON responses; use POST /mcp.' },
        id: null,
      });
    });
  }

  // ---- Operational --------------------------------------------------------
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      operations: operationCount,
      domains: domainBreakdown,
      writes: config.allowWrites,
      knowledge: knowledge
        ? { guides: knowledge.size, errorCodes: knowledge.errorCount,
            ...knowledge.provenance }
        : null,
      sessions: sessions.size,
      storage: config.storageBackend,
    });
  });

  app.get('/', (_req, res) => {
    const { html } = page('Zoho Analytics Code Mode', `
      <h1>Zoho Analytics Code Mode</h1>
      <div class="ok">
        <p>This server is running and ready for MCP clients.</p>
      </div>
      <p>Add it to your MCP client configuration:</p>
      <pre><code>{
  "mcpServers": {
    "zoho-analytics-code": {
      "url": "${escapeHtml(config.publicUrl)}/mcp",
      "type": "http"
    }
  }
}</code></pre>
      <p>Your client will open a browser so you can sign in to Zoho. There is no
      token to copy and nothing to install.</p>
      <p>${operationCount} operations available,
      ${config.allowWrites ? 'read and write' : 'read-only'}.</p>`);
    res.type('html').send(html);
  });

  return app;
}
