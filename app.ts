// app.ts — the server: one router over the forge's four surfaces.
//
//   GET  /healthz                    the env's boot probe (no auth)
//   GET|POST /{owner}/{repo}.git/*   git smart HTTP (upload-pack v2 + v0, receive-pack v0)
//   /api/v3/*                        GitHub REST v3
//   POST /api/graphql                GraphQL v4 (single operations and batches)
//   POST /mcp                        Model Context Protocol (JSON-RPC 2.0)
//
// Every surface except /healthz requires the bearer token the env injects as
// MAKEFUN_SHOP_TOKEN; without it (or with a wrong one) the answer is 401. When the
// env var is unset — local development only — any non-empty bearer token is accepted
// and a missing one is still a 401. A request handler never throws: unexpected errors
// answer 500 JSON and the server stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, ServiceError } from './store.ts';
import { GitError } from './gitcore.ts';
import { handleRest, type RestContext } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { gitPathOf, handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (git push packs are far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** The next deterministic request id (every reply carries one, errors included). */
function nextRequestId(): string {
  return `req-${(requestCounter += 1)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** The path and query of a request URL, parsed once (never a throw from a request). */
function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Whether the request's Authorization header names the env's token. */
function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (expected === '') return true; // local development: any non-empty bearer token
  return presented === expected;
}

/** Read a request body up to the cap; null when it is too large. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegments(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** The GraphQL endpoint: one operation, or a batch array of operations in order. */
function handleGraphQL(forge: Forge, res: ServerResponse, bodyRaw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRaw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { errors: [{ message: 'the request body is not valid JSON' }] });
  }
  const runOne = (operation: unknown): unknown => {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      return { data: null, errors: [{ message: 'an operation must be a JSON object' }] };
    }
    const { query, variables, operationName } = operation as Record<string, unknown>;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'a query string is required' }] };
    }
    const vars =
      variables !== null && typeof variables === 'object' && !Array.isArray(variables)
        ? (variables as Record<string, unknown>)
        : {};
    const name = typeof operationName === 'string' ? operationName : null;
    return executeGraphQL(forge, query, vars, name);
  };
  if (Array.isArray(parsed)) {
    return sendJson(res, 200, parsed.map(runOne));
  }
  return sendJson(res, 200, runOne(parsed));
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(forge: Forge = new Forge()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { path, query } = urlOf(req);
      const method = req.method ?? 'GET';

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const bodyRaw = needsBody ? await readBody(req) : Buffer.alloc(0);
        if (bodyRaw === null) {
          sendJson(res, 413, { message: 'the request body is too large' });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' || path === '/api/v3/' ? '' : path.slice('/api/v3'.length);
          const ctx: RestContext = {
            forge,
            method,
            segments: decodeSegments(restPath),
            path: restPath === '' ? '/' : restPath,
            query,
            host: req.headers.host ?? 'localhost',
            requestId: `req-${(requestCounter += 1)}`,
            bodyRaw,
            res,
          };
          handleRest(ctx);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          handleGraphQL(forge, res, bodyRaw);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          handleMcp(forge, res, bodyRaw);
          return;
        }

        // Git smart HTTP.
        const gitPath = gitPathOf(path);
        if (gitPath !== null) {
          if (method === 'GET' && gitPath.rest === 'info/refs') {
            handleInfoRefs(forge, gitPath.owner, gitPath.repo, req, res, query);
            return;
          }
          if (method === 'POST' && gitPath.rest === 'git-upload-pack') {
            handleUploadPack(forge, gitPath.owner, gitPath.repo, req, res, bodyRaw);
            return;
          }
          if (method === 'POST' && gitPath.rest === 'git-receive-pack') {
            handleReceivePack(forge, gitPath.owner, gitPath.repo, req, res, bodyRaw);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (res.writableEnded) return;
        if (err instanceof ServiceError) {
          sendJson(res, err.status, { message: err.message });
          return;
        }
        if (err instanceof GitError) {
          sendJson(res, 400, { message: err.message });
          return;
        }
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    })();
  });
}
