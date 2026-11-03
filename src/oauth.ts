/**
 * OAuth 2.1 for MCP clients that sign in instead of taking a token (the Claude app, ChatGPT).
 * There is no user database: the consent page asks for one of your agent tokens, and the grant
 * acts as that agent. Static tokens keep working on /mcp, /api and /t/<token>/.
 */
import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from './types';
import { resolveAgent } from './auth';
import { audit } from './indexer';

type Handler = { fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> };

const providers = new Map<string, OAuthProvider<Env>>();

/** One provider per origin: the protected resource URL must name this deployment's own /mcp. */
export function oauthProvider(origin: string, app: Handler, mcp: Handler): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcp,
      defaultHandler: app,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'memory-gateway' },
      // Static agent tokens sent as a Bearer header on /mcp.
      resolveExternalToken: async ({ token, env }) => {
        const agent = await resolveAgent(env, token);
        return agent ? { props: { agent }, audience: `${origin}/mcp` } : null;
      },
    });
    providers.set(origin, p);
  }
  return p;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(body: string, status = 200, headers = new Headers()): Response {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>memory-gateway sign-in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 16px;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}input{background:#222;color:#ddd}}
input{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #888;border-radius:6px}
button{padding:.6rem 1.2rem;font:inherit;border-radius:6px;border:1px solid #888;margin-right:.5rem}
.warn{color:#b45309}</style>${body}</html>`,
    { status, headers },
  );
}

/** GET/POST /authorize: the consent page. */
export async function authorize(req: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === 'GET') {
      const request = await oauth.parseAuthRequest(req);
      const d = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      const who = d.clientDomain ? ` (published by <strong>${esc(d.clientDomain)}</strong>)` : ' (name not verified)';
      return page(
        `<h1>Connect ${esc(d.clientName)} to your vault?</h1>
<p>${esc(d.clientName)}${who} will get access sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>' : ''}
<form method="post">
<input type="hidden" name="handle" value="${esc(consent.handle)}">
<p><label>Agent token it should act as<br><input type="password" name="token" autocomplete="off" required></label></p>
<p><button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`,
        200,
        consent.headers,
      );
    }
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const form = await req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // Checked before approveConsent, so a typo leaves the handle usable: go back and retry.
    const agent = await resolveAgent(env, String(form.get('token') ?? '').trim());
    if (!agent) return page('<h1>Wrong token</h1><p>Go back and paste one of your agent tokens.</p>', 401);
    const approved = await oauth.approveConsent(req, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: encodeURIComponent(agent),
      metadata: {},
      scope: approved.request.scope,
      props: { agent },
    });
    await audit(env, agent, 'oauth-grant', approved.request.clientId);
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      const msg = e instanceof AuthorizationError ? e.description : 'This app could not be verified.';
      return page(`<h1>Sign-in failed</h1><p>${esc(msg)}</p><p>Start the connection again from your app.</p>`, 400);
    }
    throw e;
  }
}
