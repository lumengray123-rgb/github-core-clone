// graphql.ts — a small GraphQL parser and executor for the v4 surface at /api/graphql.
// It implements the documents gh and github-mcp-server send (viewer, repository, issue
// and pull-request reads, the create/close/merge mutations, node(id:), __type probes
// and operation batching), with validation errors for unknown fields.
//
// No GraphQL library is used: the parser is a recursive-descent reader over the
// document text, and the executor walks the schema table below.

import {
  Forge,
  ServiceError,
  VIEWER_ID,
  VIEWER_LOGIN,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | { readonly __enum: string }
  | { readonly __var: string }
  | readonly GqlValue[]
  | { readonly [key: string]: GqlValue };

export interface GqlField {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, GqlValue>;
  readonly selections: GqlSelection[];
}

export interface GqlFragment {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selections: GqlSelection[];
}

export interface GqlSpread {
  readonly kind: 'spread';
  readonly name: string;
}

export type GqlSelection = GqlField | GqlFragment | GqlSpread;

export interface GqlOperation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: GqlSelection[];
}

export interface GqlDocument {
  readonly operations: GqlOperation[];
  readonly fragments: Map<string, GqlFragment & { typeCondition: string }>;
}

class GqlSyntaxError extends Error {}

interface Token {
  readonly kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'ellipsis' | 'eof';
  readonly value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (index < input.length) {
    const ch = input[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && input.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      index += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      // A block string (""") is read as one string; the suite never sends one.
      if (input.slice(index, index + 3) === '"""') {
        const end = input.indexOf('"""', index + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let out = '';
      index += 1;
      let closed = false;
      while (index < input.length) {
        const c = input[index++];
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const esc = input[index++];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(index, index + 4), 16));
            index += 4;
          } else out += esc;
          continue;
        }
        out += c;
      }
      if (!closed) throw new GqlSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      const start = index;
      if (input[index] === '-') index += 1;
      while (index < input.length && isDigit(input[index])) index += 1;
      let isFloat = false;
      if (input[index] === '.' && isDigit(input[index + 1] ?? '')) {
        isFloat = true;
        index += 1;
        while (index < input.length && isDigit(input[index])) index += 1;
      }
      if (input[index] === 'e' || input[index] === 'E') {
        isFloat = true;
        index += 1;
        if (input[index] === '+' || input[index] === '-') index += 1;
        while (index < input.length && isDigit(input[index])) index += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(start, index) });
      continue;
    }
    if (isNameStart(ch)) {
      const start = index;
      while (index < input.length && isNameChar(input[index])) index += 1;
      tokens.push({ kind: 'name', value: input.slice(start, index) });
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GqlSyntaxError(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GqlSyntaxError(`expected ${what}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlFragment & { typeCondition: string }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipVariableDefinitions();
        const selections = this.parseSelectionSet();
        operations.push({ kind, name, selections });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        const on = this.expectName('"on"');
        if (on !== 'on') throw new GqlSyntaxError('a fragment needs "on Type"');
        const typeCondition = this.expectName('a fragment type');
        this.skipDirectives();
        fragments.set(name, { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new GqlSyntaxError(`unexpected token ${JSON.stringify(token.value)} at the document level`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new GqlSyntaxError('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GqlSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName('a field name');
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName('a field name');
    }
    let args: Record<string, GqlValue> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: GqlSelection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new GqlSyntaxError('unterminated arguments');
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { __var: this.expectName('a variable name') };
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new GqlSyntaxError('unterminated list');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return values;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, GqlValue> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new GqlSyntaxError('unterminated input object');
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        object[name] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    throw new GqlSyntaxError(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

export function parseGraphQL(document: string): GqlDocument {
  return new Parser(document).parseDocument();
}

/** Resolve variables and enum literals in a parsed value. */
function resolveValue(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  if (value !== null && typeof value === 'object' && '__var' in value) {
    return (value as { __var: string }).__var in variables ? variables[(value as { __var: string }).__var] : undefined;
  }
  if (value !== null && typeof value === 'object' && '__enum' in value) {
    return (value as { __enum: string }).__enum;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, GqlValue>, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

interface FieldDef {
  /** Return type, written with [ ] for lists; '!' is not used. */
  readonly type: string;
  readonly resolve: (node: GqlNode, args: Record<string, unknown>, ctx: GqlContext) => unknown;
}

interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  readonly fields: Record<string, FieldDef>;
  readonly enumValues: string[];
}

const FIELD = (
  type: string,
  resolve: (node: GqlNode, args: Record<string, unknown>, ctx: GqlContext) => unknown,
): FieldDef => ({ type, resolve });

const SCALAR = <T extends GqlNode>(type: string, pick: (node: T) => unknown): FieldDef =>
  FIELD(type, (node) => pick(node as T));

// Node values carry a __typename plus the payload their resolvers need.
type GqlNode = { readonly __typename: string; [key: string]: unknown };

interface GqlContext {
  readonly forge: Forge;
}

const USER_ID = (): string => globalId('user', VIEWER_ID);

function viewerNode(): GqlNode {
  return { __typename: 'User', login: VIEWER_LOGIN, id: USER_ID() };
}

function repoNode(repo: Repo): GqlNode {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): GqlNode {
  return { __typename: 'PullRequest', repo, pull };
}

function refNode(name: string): GqlNode {
  return { __typename: 'Ref', name };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  return pull.mergedAt !== null ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveRepository(forge: Forge, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}

function repositoryFromGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo' || decoded.parts.length !== 1) return null;
  const dbid = Number(decoded.parts[0]);
  if (!Number.isInteger(dbid)) return null;
  for (const repo of forge.listRepos()) {
    if (repo.dbid === dbid) return repo;
  }
  return null;
}

function issueFromGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue' || decoded.parts.length !== 2) return null;
  const repo = repositoryFromGlobalId(forge, globalId('repo', Number(decoded.parts[0])));
  if (!repo) return null;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue ? { repo, issue } : null;
}

function pullFromGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pr' || decoded.parts.length !== 2) return null;
  const repo = repositoryFromGlobalId(forge, globalId('repo', Number(decoded.parts[0])));
  if (!repo) return null;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  return pull ? { repo, pull } : null;
}

function inputObject(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  let issues = [...repo.issues.values()];
  if (states !== null) issues = issues.filter((issue) => states.includes(issueState(issue)));
  issues.sort((a, b) =>
    direction === 'DESC' ? b.createdSeq - a.createdSeq || b.number - a.number : a.createdSeq - b.createdSeq || a.number - b.number,
  );
  const after = decodeCursor(args.after);
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'DESC' ? issue.number < after : issue.number > after));
  }
  const totalCount = issues.length;
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    totalCount,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length ? encodeCursor(page[0].number) : null,
      endCursor: page.length ? encodeCursor(page[page.length - 1].number) : null,
    },
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : ['OPEN'];
  let pulls = [...repo.pulls.values()].filter((pull) => states.includes(pullState(pull)));
  pulls.sort((a, b) => b.number - a.number);
  const after = decodeCursor(args.after);
  if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : pulls.length;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    totalCount: pulls.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: pulls.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: page.length ? encodeCursor(page[0].number) : null,
      endCursor: page.length ? encodeCursor(page[page.length - 1].number) : null,
    },
  };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: FIELD('User', () => viewerNode()),
      repository: FIELD('Repository', (_node, args, ctx) => {
        const repo = resolveRepository(ctx.forge, args.owner, args.name);
        return repo === null ? null : repoNode(repo);
      }),
      node: FIELD('Node', (_node, args, ctx) => {
        if (typeof args.id !== 'string') return null;
        const decoded = decodeGlobalId(args.id);
        if (decoded === null) return null;
        if (decoded.kind === 'repo') {
          const repo = repositoryFromGlobalId(ctx.forge, args.id);
          return repo ? repoNode(repo) : null;
        }
        if (decoded.kind === 'issue') {
          const found = issueFromGlobalId(ctx.forge, args.id);
          return found ? issueNode(found.repo, found.issue) : null;
        }
        if (decoded.kind === 'pr') {
          const found = pullFromGlobalId(ctx.forge, args.id);
          return found ? pullNode(found.repo, found.pull) : null;
        }
        return null;
      }),
      __type: FIELD('__Type', (_node, args) => {
        if (typeof args.name !== 'string') return null;
        return args.name in SCHEMA ? { __typename: '__Type', typeName: args.name } : null;
      }),
    },
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: FIELD('CreateIssuePayload', (_node, args, ctx) => {
        const input = inputObject(args);
        const repo = repositoryFromGlobalId(ctx.forge, input.repositoryId);
        if (!repo) throw new ServiceError(422, 'the repository id does not name a repository');
        const title = typeof input.title === 'string' ? input.title : '';
        const issue = ctx.forge.createIssue(repo, {
          title,
          body: typeof input.body === 'string' ? input.body : undefined,
        });
        return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
      }),
      closeIssue: FIELD('CloseIssuePayload', (_node, args, ctx) => {
        const input = inputObject(args);
        const found = issueFromGlobalId(ctx.forge, input.issueId);
        if (!found) throw new ServiceError(422, 'the issue id does not name an issue');
        const issue = ctx.forge.patchIssue(found.repo, found.issue.number, { state: 'closed' });
        return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, issue) };
      }),
      createPullRequest: FIELD('CreatePullRequestPayload', (_node, args, ctx) => {
        const input = inputObject(args);
        const repo = repositoryFromGlobalId(ctx.forge, input.repositoryId);
        if (!repo) throw new ServiceError(422, 'the repository id does not name a repository');
        const pull = ctx.forge.createPull(repo, {
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : undefined,
        });
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
      }),
      mergePullRequest: FIELD('MergePullRequestPayload', (_node, args, ctx) => {
        const input = inputObject(args);
        const found = pullFromGlobalId(ctx.forge, input.pullRequestId);
        if (!found) throw new ServiceError(422, 'the pull request id does not name a pull request');
        ctx.forge.mergePull(found.repo, found.pull.number);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
      }),
      addComment: FIELD('AddCommentPayload', (_node, args, ctx) => {
        const input = inputObject(args);
        const found = issueFromGlobalId(ctx.forge, input.subjectId);
        if (!found) throw new ServiceError(422, 'the subject id does not name an issue');
        const comment = ctx.forge.addComment(found.repo, found.issue.number, typeof input.body === 'string' ? input.body : '');
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: globalId('comment', found.repo.dbid, found.issue.number, comment.id),
              body: comment.body,
            },
          },
        };
      }),
    },
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: SCALAR('ID', (node) => node.id),
      login: SCALAR('String', (node) => node.login),
    },
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: FIELD('ID', (node) => globalId('repo', (node.repo as Repo).dbid)),
      databaseId: FIELD('Int', (node) => (node.repo as Repo).dbid),
      name: FIELD('String', (node) => (node.repo as Repo).name),
      nameWithOwner: FIELD('String', (node) => `${VIEWER_LOGIN}/${(node.repo as Repo).name}`),
      description: FIELD('String', (node) => (node.repo as Repo).description),
      owner: FIELD('User', () => viewerNode()),
      defaultBranchRef: FIELD('Ref', (node) => refNode((node.repo as Repo).defaultBranch)),
      viewerPermission: SCALAR('RepositoryPermission', () => 'ADMIN'),
      hasIssuesEnabled: SCALAR('Boolean', () => true),
      issue: FIELD('Issue', (node, args) => {
        const repo = node.repo as Repo;
        const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
        return issue ? issueNode(repo, issue) : null;
      }),
      issues: FIELD('IssueConnection', (node, args) => issuesConnection(node.repo as Repo, args)),
      pullRequest: FIELD('PullRequest', (node, args) => {
        const repo = node.repo as Repo;
        const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
        return pull ? pullNode(repo, pull) : null;
      }),
      pullRequests: FIELD('PullRequestConnection', (node, args) => pullRequestsConnection(node.repo as Repo, args)),
    },
    enumValues: [],
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: SCALAR('String', (node) => node.name),
    },
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: FIELD('ID', (node) => globalId('issue', (node.repo as Repo).dbid, (node.issue as Issue).number)),
      number: FIELD('Int', (node) => (node.issue as Issue).number),
      title: FIELD('String', (node) => (node.issue as Issue).title),
      body: FIELD('String', (node) => (node.issue as Issue).body),
      state: FIELD('IssueState', (node) => issueState(node.issue as Issue)),
      createdAt: FIELD('String', (node, _args, ctx) => ctx.forge.timestamp((node.issue as Issue).createdSeq)),
      updatedAt: FIELD('String', (node, _args, ctx) => ctx.forge.timestamp((node.issue as Issue).updatedSeq)),
    },
    enumValues: [],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: SCALAR('[Issue]', (node) => node.nodes),
      totalCount: SCALAR('Int', (node) => node.totalCount),
      pageInfo: SCALAR('PageInfo', (node) => node.pageInfo),
    },
    enumValues: [],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: SCALAR('Boolean', (node) => node.hasNextPage),
      hasPreviousPage: SCALAR('Boolean', (node) => node.hasPreviousPage),
      startCursor: SCALAR('String', (node) => node.startCursor),
      endCursor: SCALAR('String', (node) => node.endCursor),
    },
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: FIELD('ID', (node) => globalId('pr', (node.repo as Repo).dbid, (node.pull as Pull).number)),
      number: FIELD('Int', (node) => (node.pull as Pull).number),
      title: FIELD('String', (node) => (node.pull as Pull).title),
      body: FIELD('String', (node) => (node.pull as Pull).body),
      state: FIELD('PullRequestState', (node) => pullState(node.pull as Pull)),
      merged: FIELD('Boolean', (node) => (node.pull as Pull).mergedAt !== null),
      headRefName: FIELD('String', (node) => (node.pull as Pull).headRef),
      baseRefName: FIELD('String', (node) => (node.pull as Pull).baseRef),
      mergeable: FIELD('MergeableState', (node, _args, ctx) => {
        const pull = node.pull as Pull;
        if (pull.state !== 'open') return 'UNKNOWN';
        return ctx.forge.pullMergeable(node.repo as Repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }),
      files: FIELD('PullRequestChangedFileConnection', (node, args, ctx) => {
        const repo = node.repo as Repo;
        const pull = node.pull as Pull;
        const files = ctx.forge.pullFiles(repo, pull);
        const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : files.length;
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: files.slice(0, first).map((file) => {
            const { additions, deletions } = ctx.forge.pullFileCounts(repo, file);
            return {
              __typename: 'PullRequestChangedFile',
              path: file.path,
              additions,
              deletions,
              changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
            };
          }),
        };
      }),
    },
    enumValues: [],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: SCALAR('[PullRequest]', (node) => node.nodes),
      totalCount: SCALAR('Int', (node) => node.totalCount),
      pageInfo: SCALAR('PageInfo', (node) => node.pageInfo),
    },
    enumValues: [],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: SCALAR('[PullRequestChangedFile]', (node) => node.nodes),
    },
    enumValues: [],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: SCALAR('String', (node) => node.path),
      additions: SCALAR('Int', (node) => node.additions),
      deletions: SCALAR('Int', (node) => node.deletions),
      changeType: SCALAR('PullRequestChangedFileChangeType', (node) => node.changeType),
    },
    enumValues: [],
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: SCALAR('Issue', (node) => node.issue) },
    enumValues: [],
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: SCALAR('Issue', (node) => node.issue) },
    enumValues: [],
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: SCALAR('PullRequest', (node) => node.pullRequest) },
    enumValues: [],
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: SCALAR('PullRequest', (node) => node.pullRequest) },
    enumValues: [],
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: SCALAR('IssueCommentEdge', (node) => node.commentEdge) },
    enumValues: [],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: { node: SCALAR('IssueComment', (node) => node.node) },
    enumValues: [],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: SCALAR('ID', (node) => node.id),
      body: SCALAR('String', (node) => node.body),
    },
    enumValues: [],
  },
  Node: {
    kind: 'INTERFACE',
    fields: { id: SCALAR('ID', (node) => node.id as string) },
    enumValues: [],
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: SCALAR('String', (node) => node.typeName),
      kind: FIELD('String', (node) => SCHEMA[node.typeName as string]?.kind ?? 'OBJECT'),
      fields: FIELD('[__Field]', (node) => {
        const def = SCHEMA[node.typeName as string];
        if (!def) return null;
        return Object.keys(def.fields).map((name) => ({ __typename: '__Field', name }));
      }),
      enumValues: FIELD('[__EnumValue]', (node) => {
        const def = SCHEMA[node.typeName as string];
        if (!def || def.kind !== 'ENUM') return null;
        return def.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
      }),
    },
    enumValues: [],
  },
  __Field: {
    kind: 'OBJECT',
    fields: { name: SCALAR('String', (node) => node.name) },
    enumValues: [],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: SCALAR('String', (node) => node.name) },
    enumValues: [],
  },
  IssueState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: {}, enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: {
    kind: 'ENUM',
    fields: {},
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  PullRequestMergeMethod: { kind: 'ENUM', fields: {}, enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrderField: { kind: 'ENUM', fields: {}, enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: {}, enumValues: ['ASC', 'DESC'] },
  SearchType: {
    kind: 'ENUM',
    fields: {},
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE'],
  },
  PullRequestChangedFileChangeType: {
    kind: 'ENUM',
    fields: {},
    enumValues: ['ADDED', 'MODIFIED', 'REMOVED'],
  },
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
}

function unwrapType(type: string): string {
  let inner = type.trim();
  while (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1).trim();
  return inner.replace(/!$/, '');
}

function isListType(type: string): boolean {
  return type.trim().startsWith('[');
}

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

class Executor {
  private readonly forge: Forge;
  private readonly document: GqlDocument;
  private readonly variables: Readonly<Record<string, unknown>>;
  private readonly errors: GqlError[] = [];

  constructor(forge: Forge, document: GqlDocument, variables: Readonly<Record<string, unknown>>) {
    this.forge = forge;
    this.document = document;
    this.variables = variables;
  }

  run(operationName: string | null): { data: Record<string, unknown> | null; errors: GqlError[] } {
    let operation: GqlOperation | undefined;
    if (operationName !== null) {
      operation = this.document.operations.find((op) => op.name === operationName);
      if (!operation) {
        return {
          data: null,
          errors: [{ message: `Unknown operation named "${operationName}".` }],
        };
      }
    } else {
      operation = this.document.operations[0];
      if (!operation) return { data: null, errors: [{ message: 'The document names no operation.' }] };
    }
    const root: GqlNode = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
    const ctx: GqlContext = { forge: this.forge };
    const data = this.executeSelectionSet(operation.selections, root, ctx, []);
    return { data, errors: this.errors };
  }

  private executeSelectionSet(
    selections: GqlSelection[],
    node: GqlNode,
    ctx: GqlContext,
    path: (string | number)[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = this.document.fragments.get(selection.name);
        if (!fragment) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
          continue;
        }
        if (fragment.typeCondition !== node.__typename) continue;
        Object.assign(out, this.executeSelectionSet(fragment.selections, node, ctx, path));
        continue;
      }
      if (selection.kind === 'fragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== node.__typename) continue;
        Object.assign(out, this.executeSelectionSet(selection.selections, node, ctx, path));
        continue;
      }
      const key = selection.alias ?? selection.name;
      const typeName = node.__typename;
      const def = SCHEMA[typeName]?.fields[selection.name] ?? SCHEMA.Node.fields[selection.name];
      if (!def) {
        this.errors.push({
          message: `Cannot query field "${selection.name}" on type "${typeName}".`,
          path: [...path, key],
        });
        out[key] = null;
        continue;
      }
      const args = resolveArgs(selection.args, this.variables);
      let value: unknown;
      try {
        value = def.resolve(node, args, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'the field could not be resolved';
        this.errors.push({ message, path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = this.completeValue(value, def.type, selection.selections, ctx, [...path, key]);
    }
    return out;
  }

  private completeValue(
    value: unknown,
    type: string,
    selections: GqlSelection[],
    ctx: GqlContext,
    path: (string | number)[],
  ): unknown {
    if (value === null || value === undefined) return null;
    if (isListType(type)) {
      if (!Array.isArray(value)) return null;
      const inner = type.trim().slice(1, -1).trim();
      return value.map((entry, index) => this.completeValue(entry, inner, selections, ctx, [...path, index]));
    }
    const named = unwrapType(type);
    if (SCALAR_TYPES.has(named)) return value;
    if (SCHEMA[named]?.kind === 'ENUM') return value;
    if (typeof value !== 'object' || value === null) return null;
    return this.executeSelectionSet(selections, value as GqlNode, ctx, path);
  }
}

/** Execute one GraphQL operation; returns the response envelope. */
export function executeGraphQL(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  let document: GqlDocument;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'the document could not be parsed';
    return { data: null, errors: [{ message }] };
  }
  const executor = new Executor(forge, document, variables);
  const result = executor.run(operationName);
  return result.errors.length ? { data: result.data, errors: result.errors } : { data: result.data };
}
