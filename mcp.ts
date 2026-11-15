// mcp.ts — the Model Context Protocol surface at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks the modern revision (2026-07-28) via server/discover and the legacy handshake
// (initialize + notifications/initialized) for older clients. Six tools act on the same
// Forge store as the REST surface, so objects created here read back over REST unchanged.

import type { ServerResponse } from 'node:http';
import { Forge, ServiceError, VIEWER_LOGIN, type Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_VERSIONS = [MODERN_REVISION, ...LEGACY_REVISIONS];

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const stringProp = (description: string): { type: string; description: string } => ({ type: 'string', description });

// The tool list is a module-level constant: two tools/list calls answer it byte for byte.
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The name of the repository to create.'),
        description: stringProp('An optional description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
        state: stringProp('Filter issues by state: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the pull request.'),
        head: stringProp('The head branch the pull request merges from.'),
        base: stringProp('The base branch the pull request merges into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function result(res: ServerResponse, id: JsonRpcId, value: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
}

function rpcError(res: ServerResponse, id: JsonRpcId, code: number, message: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

/** The canonical tool name: strip any server prefix (github__create_issue -> create_issue). */
function canonicalToolName(name: string): string {
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return bare.toLowerCase();
}

const ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  get_repository: 'get_repo',
  issue_create: 'create_issue',
  issues_list: 'list_issues',
  create_pr: 'create_pull_request',
  merge_pr: 'merge_pull_request',
};

function argString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function argNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function toolTextResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const structured = typeof value === 'string' ? undefined : value;
  const out: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (structured !== undefined) out.structuredContent = structured;
  return out;
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Run one tool. Returns the tool result (with isError on a tool-level failure) or throws
 * a ServiceError, which the dispatcher turns into isError too.
 */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const canonical = ALIASES[canonicalToolName(name)] ?? canonicalToolName(name);

  // The suite may fill `full_name` instead of owner/repo; split it when present.
  let owner = argString(args, 'owner', 'owner_login', 'org', 'user', 'login');
  let repoName = argString(args, 'repo', 'repository', 'repo_name');
  const fullName = argString(args, 'full_name');
  if ((owner === undefined || repoName === undefined) && fullName !== undefined) {
    const [ownerPart, repoPart] = fullName.split('/');
    owner ??= ownerPart;
    repoName ??= repoPart;
  }

  const needRepo = (): Repo => {
    if (owner === undefined || repoName === undefined) {
      throw new ServiceError(422, 'owner and repo are required');
    }
    const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) : undefined;
    if (!repo) throw new ServiceError(404, `Repository ${owner}/${repoName} not found`);
    return repo;
  };

  switch (canonical) {
    case 'create_repo': {
      const nameArg = argString(args, 'name');
      if (nameArg === undefined) return toolErrorResult('name is required');
      const repo = forge.createRepo(nameArg, {
        description: argString(args, 'description'),
        private: args.private === true,
      });
      return toolTextResult(forge.repoJson(repo));
    }
    case 'get_repo': {
      const repo = needRepo();
      return toolTextResult(forge.repoJson(repo));
    }
    case 'create_issue': {
      const repo = needRepo();
      const title = argString(args, 'title');
      if (title === undefined) return toolErrorResult('title is required');
      const issue = forge.createIssue(repo, { title, body: argString(args, 'body') });
      return toolTextResult(forge.issueObject(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo();
      const state = argString(args, 'state') ?? 'open';
      const issues = forge.listIssues(repo, state, 'desc');
      return toolTextResult(issues.map((issue) => forge.issueObject(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = needRepo();
      const title = argString(args, 'title');
      const head = argString(args, 'head', 'head_branch', 'head_ref');
      const base = argString(args, 'base', 'base_branch', 'base_ref') ?? repo.defaultBranch;
      if (title === undefined) return toolErrorResult('title is required');
      if (head === undefined) return toolErrorResult('head is required');
      const pull = forge.createPull(repo, { head, base, title, body: argString(args, 'body') });
      return toolTextResult(forge.pullObject(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      const number = argNumber(args, 'pull_number', 'pull_request_number', 'number');
      if (number === undefined) return toolErrorResult('pull_number is required');
      const { sha } = forge.mergePull(repo, number);
      return toolTextResult({ sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      throw new ServiceError(32602, `Unknown tool: ${name}`);
  }
}

/** The MCP dispatcher. Assumes auth was already checked by the router. */
export function handleMcp(forge: Forge, res: ServerResponse, bodyRaw: Buffer): void {
  let request: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(bodyRaw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return rpcError(res, null, -32700, 'Parse error: the request body must be a JSON-RPC object', 400);
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return rpcError(res, null, -32700, 'Parse error: the request body is not valid JSON', 400);
  }

  const id: JsonRpcId = request.id ?? null;
  const isNotification = request.id === undefined;

  if (typeof request.method !== 'string') {
    if (isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    return rpcError(res, id, -32600, 'Invalid Request: a method is required');
  }

  // Notifications carry no id and expect no reply body.
  if (isNotification) {
    res.writeHead(202);
    res.end();
    return;
  }

  const params = request.params ?? {};

  switch (request.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return result(res, id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : MODERN_REVISION;
      return result(res, id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping': {
      return result(res, id, {});
    }
    case 'tools/list': {
      return result(res, id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args =
        params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const canonical = ALIASES[canonicalToolName(toolName)] ?? canonicalToolName(toolName);
      if (!TOOLS.some((tool) => tool.name === canonical)) {
        return rpcError(res, id, -32602, `Unknown tool: ${toolName}`);
      }
      try {
        return result(res, id, callTool(forge, toolName, args));
      } catch (err) {
        if (err instanceof ServiceError && err.status === 32602) {
          return rpcError(res, id, -32602, err.message);
        }
        const message = err instanceof Error ? err.message : 'the tool call failed';
        return result(res, id, toolErrorResult(message));
      }
    }
    case 'resources/list':
      return result(res, id, { resources: [] });
    case 'prompts/list':
      return result(res, id, { prompts: [] });
    default:
      return rpcError(res, id, -32601, `Method not found: ${request.method}`);
  }
}
