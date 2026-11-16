// The forge's HTTP server: one process answering four surfaces over one store — git smart
// HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and MCP at
// /mcp — plus the env's /healthz probe. Everything but /healthz requires the bearer token
// from MAKEFUN_SHOP_TOKEN; a missing or wrong token is a 401 with a JSON message, and an
// unknown route is a 404 with one. When the token env var is unset (a local run) the forge
// serves without auth so it can be exercised by hand.

import { createForgeServer, type ForgeRequest, type ForgeResponse, type ForgeServer } from './transport.ts';
import { Store } from './store.ts';
import { infoRefs, receivePack, uploadPack, type HandlerResult } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { readBody, sendError, sendJson } from './http.ts';

function sendResult(res: ForgeResponse, result: HandlerResult): void {
  res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
  res.end(result.body);
}

function authorized(req: ForgeRequest, expectedAuth: string | null): boolean {
  if (expectedAuth === null) return true;
  return req.headers.authorization === expectedAuth;
}

/**
 * Split a request target into path and query without building a URL object: the router
 * only ever needs the raw path (it decodes segment by segment itself) and the query as
 * search params. An absolute-form target, which this suite never sends, still goes
 * through the URL parser so its answer stays the one the old code gave.
 */
function splitTarget(raw: string): { pathname: string; searchParams: URLSearchParams } | null {
  if (raw.startsWith('/')) {
    const queryAt = raw.indexOf('?');
    return {
      pathname: queryAt === -1 ? raw : raw.slice(0, queryAt),
      searchParams: new URLSearchParams(queryAt === -1 ? '' : raw.slice(queryAt + 1)),
    };
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    return null;
  }
}

async function route(store: Store, expectedAuth: string | null, req: ForgeRequest, res: ForgeResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const target = splitTarget(req.url ?? '/');
  if (target === null) {
    sendError(store, res, 400, 'Bad Request');
    return;
  }
  const pathname = target.pathname;
  const segments = pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      // Almost every segment is plain text with nothing to decode; the decoder
      // only earns its call when an escape is actually present.
      if (!segment.includes('%')) return segment;
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  // The env's boot check: no auth, always the same answer.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(store, res, 200, { ok: true });
    return;
  }

  if (!authorized(req, expectedAuth)) {
    sendError(store, res, 401, 'Bad credentials');
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(store, req, res, pathname, segments.slice(2), target.searchParams);
    return;
  }

  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendError(store, res, 404, 'Not Found');
      return;
    }
    await handleGraphQL(store, req, res);
    return;
  }

  if (pathname === '/mcp') {
    await handleMcp(store, req, res);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const repo = store.repoFor(owner, repoName);
    if (repo === null) {
      sendError(store, res, 404, 'Not Found');
      return;
    }
    const tail = segments.slice(2).join('/');
    if (method === 'GET' && tail === 'info/refs') {
      const service = target.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendError(store, res, 400, 'service is required');
        return;
      }
      const protocol2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      sendResult(res, infoRefs(store, repo, service, protocol2));
      return;
    }
    if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
      const body = await readBody(req);
      try {
        const result = tail === 'git-upload-pack' ? uploadPack(store, repo, body) : receivePack(store, repo, body);
        sendResult(res, result);
      } catch {
        // A malformed protocol body is a 4xx and the server stays up.
        sendError(store, res, 400, 'Bad Request');
      }
      return;
    }
    sendError(store, res, 404, 'Not Found');
    return;
  }

  sendError(store, res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): ForgeServer {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  // The one header value every authenticated request must present, built once here
  // instead of a template string per request; null means the local no-auth mode.
  const expectedAuth = token === '' ? null : `Bearer ${token}`;
  const server = createForgeServer((req, res) => {
    route(store, expectedAuth, req, res).catch(() => {
      try {
        if (!res.headersSent) sendError(store, res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone; nothing sensible left to do.
      }
    });
  });
  return server;
}
