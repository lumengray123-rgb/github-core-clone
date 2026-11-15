// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry a string `message`.

import type { ServerResponse } from 'node:http';
import {
  Forge,
  ServiceError,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Repo,
} from './store.ts';

export interface RestContext {
  forge: Forge;
  method: string;
  /** Decoded path segments after /api/v3 (['repos', owner, name, ...]). */
  segments: string[];
  /** The raw path after /api/v3, for Link headers. */
  path: string;
  query: URLSearchParams;
  host: string;
  requestId: string;
  bodyRaw: Buffer;
  res: ServerResponse;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(ctx: RestContext, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(text);
}

function sendJsonText(ctx: RestContext, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(text);
}

function sendNoContent(ctx: RestContext): void {
  ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

function fail(ctx: RestContext, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Parse the request's JSON body; an invalid body is a 400. Returns null when rejected. */
function jsonBody(ctx: RestContext): Record<string, unknown> | null {
  if (ctx.bodyRaw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.bodyRaw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(ctx, 400, 'the request body must be a JSON object');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    fail(ctx, 400, 'the request body is not valid JSON');
    return null;
  }
}

/** The repository a route names, or null after answering 404. */
function needRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = owner === VIEWER_LOGIN ? ctx.forge.getRepo(owner, name) : undefined;
  if (!repo) {
    fail(ctx, 404, `Repository ${owner}/${name} not found`);
    return null;
  }
  return repo;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function stringArrayField(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Apply page/per_page to a list and build the Link header (GitHub's rel="next" form). */
function paginate<T>(ctx: RestContext, items: readonly T[]): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page >= totalPages && page === 1) return { page: slice, link: null };
  const linkFor = (target: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<http://${ctx.host}/api/v3${ctx.path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${linkFor(page + 1)}; rel="next"`);
  if (totalPages > 1) links.push(`${linkFor(totalPages)}; rel="last"`);
  if (page > 1) links.push(`${linkFor(1)}; rel="first"`, `${linkFor(page - 1)}; rel="prev"`);
  return { page: slice, link: links.length ? links.join(', ') : null };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

/** The REST dispatcher. Assumes auth was already checked by the router. */
export function handleRest(ctx: RestContext): void {
  const { method, segments } = ctx;
  try {
    // GET /api/v3/ — the API root.
    if (segments.length === 0) {
      if (method !== 'GET') return fail(ctx, 404, 'Not Found');
      return sendJson(
        ctx,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }

    if (segments[0] === 'meta' && segments.length === 1) {
      if (method !== 'GET') return fail(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, {
        installed_version: '1.0.0',
        verifiable_password_authentication: true,
        ssh_key_fingerprints: {},
        hooks: [],
      });
    }

    if (segments[0] === 'user' && segments.length === 1) {
      if (method !== 'GET') return fail(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: '',
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
      });
    }

    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const { page, link } = paginate(ctx, ctx.forge.listRepos());
        return sendJson(ctx, 200, page.map((repo) => ctx.forge.repoJson(repo)), linkHeaders(link));
      }
      if (method === 'POST') {
        const body = jsonBody(ctx);
        if (body === null) return;
        const name = stringField(body, 'name');
        if (name === undefined || name === '') return fail(ctx, 422, 'a repository name is required');
        const repo = ctx.forge.createRepo(name, {
          description: stringField(body, 'description'),
          private: body.private === true,
        });
        return sendJson(ctx, 201, ctx.forge.repoJson(repo));
      }
      return fail(ctx, 404, 'Not Found');
    }

    if (segments[0] === 'repos' && segments.length >= 3) {
      return handleRepoRoute(ctx, segments[1], segments[2], segments.slice(3));
    }

    return fail(ctx, 404, 'Not Found');
  } catch (err) {
    if (err instanceof ServiceError) return fail(ctx, err.status, err.message);
    throw err;
  }
}

function handleRepoRoute(ctx: RestContext, owner: string, name: string, rest: string[]): void {
  const { method } = ctx;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = needRepo(ctx, owner, name);
      if (!repo) return;
      return sendJson(ctx, 200, ctx.forge.repoJson(repo));
    }
    if (method === 'PATCH') {
      const repo = needRepo(ctx, owner, name);
      if (!repo) return;
      const body = jsonBody(ctx);
      if (body === null) return;
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return sendJson(ctx, 200, ctx.forge.repoJson(repo));
    }
    if (method === 'DELETE') {
      const repo = needRepo(ctx, owner, name);
      if (!repo) return;
      ctx.forge.deleteRepo(repo);
      return sendNoContent(ctx);
    }
    return fail(ctx, 404, 'Not Found');
  }

  const head = rest[0];

  if (head === 'branches') {
    const repo = needRepo(ctx, owner, name);
    if (!repo) return;
    if (rest.length === 1) {
      if (method !== 'GET') return fail(ctx, 404, 'Not Found');
      return sendJson(
        ctx,
        200,
        ctx.forge.branches(repo).map((branch) => ({
          name: branch,
          commit: { sha: ctx.forge.branchTip(repo, branch) ?? '' },
          protected: false,
        })),
      );
    }
    const branch = rest.slice(1).join('/');
    const tip = ctx.forge.branchTip(repo, branch);
    if (tip === null) return fail(ctx, 404, `Branch ${branch} not found`);
    if (method !== 'GET') return fail(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, { name: branch, commit: { sha: tip }, protected: false });
  }

  if (head === 'commits') {
    const repo = needRepo(ctx, owner, name);
    if (!repo) return;
    if (method !== 'GET' || rest.length !== 1) return fail(ctx, 404, 'Not Found');
    const ref = ctx.query.get('sha') ?? undefined;
    if (ref !== undefined && ctx.forge.resolveRef(repo, ref) === null) {
      return fail(ctx, 404, `No commit found for SHA: ${ref}`);
    }
    const perPageRaw = Number(ctx.query.get('per_page'));
    const limit = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
    const commits = ctx.forge.listCommits(repo, ref, limit);
    return sendJson(ctx, 200, commits.map((oid) => ctx.forge.commitJson(repo, oid)));
  }

  if (head === 'git' && rest[1] === 'refs') {
    const repo = needRepo(ctx, owner, name);
    if (!repo) return;
    if (rest.length === 2) {
      if (method !== 'POST') return fail(ctx, 404, 'Not Found');
      const body = jsonBody(ctx);
      if (body === null) return;
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/')) return fail(ctx, 422, 'a ref under refs/ is required');
      if (sha === undefined || !repo.objects.has(sha)) return fail(ctx, 422, 'the sha does not exist in this repository');
      if (repo.refs.has(ref)) return fail(ctx, 422, `Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      return sendJson(ctx, 201, { ref, object: { sha } });
    }
    const ref = rest.slice(2).join('/');
    const oid = repo.refs.get(ref);
    if (oid === undefined) return fail(ctx, 404, `Reference ${ref} not found`);
    if (method !== 'GET') return fail(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, { ref, object: { sha: oid } });
  }

  if (head === 'contents') {
    return handleContents(ctx, owner, name, rest.slice(1).join('/'));
  }

  if (head === 'labels') {
    const repo = needRepo(ctx, owner, name);
    if (!repo) return;
    if (method === 'GET' && rest.length === 1) {
      return sendJson(ctx, 200, [...repo.labels.values()].map((label) => ctx.forge.labelJson(label)));
    }
    if (method === 'POST' && rest.length === 1) {
      const body = jsonBody(ctx);
      if (body === null) return;
      const labelName = stringField(body, 'name');
      if (labelName === undefined || labelName === '') return fail(ctx, 422, 'a label name is required');
      const label = ctx.forge.createLabel(repo, labelName, stringField(body, 'color') ?? 'ededed');
      return sendJson(ctx, 201, ctx.forge.labelJson(label));
    }
    return fail(ctx, 404, 'Not Found');
  }

  if (head === 'issues') {
    return handleIssues(ctx, owner, name, rest.slice(1));
  }

  if (head === 'pulls') {
    return handlePulls(ctx, owner, name, rest.slice(1));
  }

  return fail(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function handleContents(ctx: RestContext, owner: string, name: string, path: string): void {
  const { method } = ctx;
  const repo = needRepo(ctx, owner, name);
  if (!repo) return;

  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? undefined;
    const tip = ctx.forge.resolveRef(repo, ref);
    if (tip === null) return fail(ctx, 404, 'Not Found');
    if (path === '') {
      const dir = ctx.forge.dirAt(repo, tip, '');
      return sendJson(ctx, 200, dir ?? []);
    }
    const file = ctx.forge.blobAt(repo, tip, path);
    if (file !== null) {
      const segments = path.split('/');
      return sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: file.data.length,
        name: segments[segments.length - 1],
        path,
        content: file.data.toString('base64'),
        sha: file.oid,
      });
    }
    const dir = ctx.forge.dirAt(repo, tip, path);
    if (dir !== null) return sendJson(ctx, 200, dir);
    return fail(ctx, 404, 'Not Found');
  }

  if (method === 'PUT') {
    const body = jsonBody(ctx);
    if (body === null) return;
    const content = stringField(body, 'content');
    if (content === undefined) return fail(ctx, 422, 'content is required');
    let data: Buffer;
    try {
      data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    } catch {
      return fail(ctx, 422, 'content is not valid base64');
    }
    const message = stringField(body, 'message') ?? `Update ${path}`;
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const sha = stringField(body, 'sha');
    // The sha check runs against the tip the new branch would fork from.
    const baseTip = ctx.forge.branchTip(repo, branch) ?? ctx.forge.branchTip(repo, repo.defaultBranch);
    const existing = baseTip === null ? null : ctx.forge.blobAt(repo, baseTip, path);
    if (existing !== null) {
      if (sha === undefined) return fail(ctx, 422, 'sha is required to update a file');
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return fail(ctx, 409, 'the sha does not match the current file');
      }
    }
    const { commitOid, contentOid } = ctx.forge.commitFile(repo, branch, path, data, message);
    const segments = path.split('/');
    return sendJson(ctx, existing !== null ? 200 : 201, {
      content: {
        name: segments[segments.length - 1],
        path,
        sha: contentOid,
        size: data.length,
        encoding: 'base64',
        content,
      },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    const body = jsonBody(ctx);
    if (body === null) return;
    const message = stringField(body, 'message') ?? `Delete ${path}`;
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const sha = stringField(body, 'sha');
    const tip = ctx.forge.branchTip(repo, branch);
    if (tip === null) return fail(ctx, 404, 'Not Found');
    const existing = ctx.forge.blobAt(repo, tip, path);
    if (existing === null) return fail(ctx, 404, 'Not Found');
    if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return fail(ctx, 409, 'the sha does not match the current file');
    }
    const { commitOid } = ctx.forge.commitFile(repo, branch, path, null, message);
    return sendJson(ctx, 200, { commit: { sha: commitOid, message } });
  }

  return fail(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------

function handleIssues(ctx: RestContext, owner: string, name: string, rest: string[]): void {
  const { method } = ctx;
  const repo = needRepo(ctx, owner, name);
  if (!repo) return;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const issues = ctx.forge.listIssues(repo, state, direction);
      const { page, link } = paginate(ctx, issues);
      return sendJson(ctx, 200, page.map((issue) => ctx.forge.issueObject(repo, issue)), linkHeaders(link));
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const title = stringField(body, 'title');
      if (title === undefined || title === '') return fail(ctx, 422, 'a title is required');
      const issue = ctx.forge.createIssue(repo, {
        title,
        body: stringField(body, 'body'),
        labels: stringArrayField(body, 'labels'),
      });
      return sendJson(ctx, 201, ctx.forge.issueObject(repo, issue));
    }
    return fail(ctx, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return fail(ctx, 404, 'Not Found');

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      const issue = repo.issues.get(number);
      if (!issue) return fail(ctx, 404, `Issue #${number} not found`);
      return sendJson(ctx, 200, issue.comments.map((comment) => ctx.forge.commentJson(comment)));
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const commentBody = stringField(body, 'body');
      if (commentBody === undefined) return fail(ctx, 422, 'a comment body is required');
      const comment = ctx.forge.addComment(repo, number, commentBody);
      return sendJson(ctx, 201, ctx.forge.commentJson(comment));
    }
    return fail(ctx, 404, 'Not Found');
  }

  if (rest.length !== 1) return fail(ctx, 404, 'Not Found');
  if (method === 'GET') {
    const issue = repo.issues.get(number);
    if (!issue) return fail(ctx, 404, `Issue #${number} not found`);
    // The hot path (the read benchmark): serve the cached serialization.
    return sendJsonText(ctx, 200, ctx.forge.issueJson(repo, issue));
  }
  if (method === 'PATCH') {
    const body = jsonBody(ctx);
    if (body === null) return;
    const issue = ctx.forge.patchIssue(repo, number, {
      state: stringField(body, 'state'),
      title: stringField(body, 'title'),
      body: stringField(body, 'body'),
    });
    return sendJson(ctx, 200, ctx.forge.issueObject(repo, issue));
  }
  return fail(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handlePulls(ctx: RestContext, owner: string, name: string, rest: string[]): void {
  const { method } = ctx;
  const repo = needRepo(ctx, owner, name);
  if (!repo) return;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const pulls = ctx.forge.listPulls(repo, state);
      const { page, link } = paginate(ctx, pulls);
      return sendJson(ctx, 200, page.map((pull) => ctx.forge.pullObject(repo, pull)), linkHeaders(link));
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const head = stringField(body, 'head');
      const base = stringField(body, 'base') ?? repo.defaultBranch;
      const title = stringField(body, 'title');
      if (head === undefined || head === '') return fail(ctx, 422, 'a head branch is required');
      if (title === undefined || title === '') return fail(ctx, 422, 'a title is required');
      const pull = ctx.forge.createPull(repo, { head, base, title, body: stringField(body, 'body') });
      return sendJson(ctx, 201, ctx.forge.pullObject(repo, pull));
    }
    return fail(ctx, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return fail(ctx, 404, 'Not Found');

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return fail(ctx, 404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (!pull) return fail(ctx, 404, `Pull request #${number} not found`);
    const files = ctx.forge.pullFiles(repo, pull);
    return sendJson(ctx, 200, files.map((file) => ctx.forge.pullFileJson(repo, file)));
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return fail(ctx, 404, 'Not Found');
    const body = jsonBody(ctx);
    if (body === null) return;
    void body; // merge_method is accepted; every merge here is a squash merge.
    const { sha } = ctx.forge.mergePull(repo, number);
    return sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  if (rest.length !== 1) return fail(ctx, 404, 'Not Found');
  if (method !== 'GET') return fail(ctx, 404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return fail(ctx, 404, `Pull request #${number} not found`);
  return sendJson(ctx, 200, ctx.forge.pullObject(repo, pull));
}
