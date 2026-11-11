/**
 * A mock Zoho Accounts server: the OAuth authorize + token endpoints, enough
 * to exercise the full browser sign-in flow offline.
 */
import { createServer } from 'node:http';

export function startMockAccounts({ clientId, clientSecret, approveUser = true } = {}) {
  const codes = new Map();
  const issued = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Stand-in for the Zoho consent screen: immediately redirect back.
    if (url.pathname === '/oauth/v2/auth') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const back = new URL(redirectUri);
      if (!approveUser) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = `zoho-code-${codes.size + 1}`;
        codes.set(code, { scope: url.searchParams.get('scope') });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/oauth/v2/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        const params = new URLSearchParams(body);
        const reply = (payload, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (params.get('client_id') !== clientId
            || params.get('client_secret') !== clientSecret) {
          return reply({ error: 'invalid_client' });
        }

        if (params.get('grant_type') === 'authorization_code') {
          if (!codes.has(params.get('code'))) return reply({ error: 'invalid_code' });
          codes.delete(params.get('code'));
        }

        const token = `zoho-access-${issued.length + 1}`;
        issued.push(token);
        return reply({
          access_token: token,
          refresh_token: 'zoho-refresh-1',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      });
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        issued,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
