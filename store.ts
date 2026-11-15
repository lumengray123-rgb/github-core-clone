// store.ts — the forge's in-memory data model and the service layer every surface
// (REST v3, GraphQL v4, MCP) shares, so an object created on one surface reads back
// identically on the others.
//
// Determinism: no wall clock and no randomness anywhere in this file. Every timestamp
// is the scenario epoch plus a monotonic sequence number, so two runs that receive the
// same requests in the same order produce byte-identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  commitHistory,
  diffTrees,
  findTreePath,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  lineDiff,
  mergeBase,
  parseCommit,
  parseTree,
  peelToNonTag,
  treeWithPath,
  type DiffFile,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';

/** The scenario epoch, 2025-01-01T00:00:00Z: every timestamp derives from it. */
export const EPOCH_SEC = 1735689600;

/** The login the trial token names (the scenario's viewer; fixed by the contest seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  readonly comments: Comment[];
  /** Cached serialization for the hot read path; cleared on any mutation. */
  jsonCache: string | null;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreate: string;
  readonly baseShaAtCreate: string;
  readonly createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  readonly dbid: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  nextNumber: number;
}

/** A service-layer failure: an HTTP status and the message the error body carries. */
export class ServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
  }
}

function notFound(what: string): ServiceError {
  return new ServiceError(404, `${what} not found`);
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRestId = 1;
  private seq = 0;

  /** The next deterministic sequence number (also the timestamp offset in seconds). */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ISO timestamp for sequence `seq` (the epoch plus `seq` seconds). */
  timestamp(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  /** The git timestamp (unix seconds) for a new commit. */
  commitTimestamp(): number {
    return EPOCH_SEC + this.tick();
  }

  /** The viewer identity a contents or merge commit carries. */
  get identity(): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** The viewer's repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      throw new ServiceError(422, `Invalid repository name ${JSON.stringify(name)}`);
    }
    if (this.repos.has(this.repoKey(VIEWER_LOGIN, name))) {
      throw new ServiceError(422, `Repository creation failed. Name "${name}" already exists.`);
    }
    const repo: Repo = {
      dbid: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.tick(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // -------------------------------------------------------------------------
  // git objects and refs
  // -------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Resolve a ref name (branch, full ref, or sha) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') ref = repo.defaultBranch;
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct;
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    return null;
  }

  /** The commit oid a branch points at, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All branch names, sorted. */
  branches(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Create a commit on `branch` that sets `path` to `blobData` (or deletes it). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    blobData: Buffer | null,
    message: string,
  ): { commitOid: string; contentOid: string | null } {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) throw new ServiceError(422, 'a file path is required');
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      // A branch that does not exist yet starts from the default branch tip (or
      // from nothing when the repository is still unborn).
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(peelToNonTag(this.lookup(repo), tip))!.data).tree;
    const blobOid = blobData === null ? null : this.putObject(repo, 'blob', blobData);
    const treeOid = treeWithPath(this.lookup(repo), (type, data) => this.putObject(repo, type, data), parentTree, segments, blobOid);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [peelToNonTag(this.lookup(repo), tip)],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.identity,
      committer: this.identity,
      timestamp: this.commitTimestamp(),
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, contentOid: blobOid };
  }

  /** The blob a commit's tree holds at `path`, or null. */
  blobAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = repo.objects.get(peelToNonTag(this.lookup(repo), commitOid));
    if (!commit || commit.type !== 'commit') return null;
    const found = findTreePath(this.lookup(repo), parseCommit(commit.data).tree, path.split('/').filter((s) => s !== ''));
    if (!found || found.mode === '40000') return null;
    const blob = repo.objects.get(found.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { oid: found.oid, data: blob.data };
  }

  /** The tree entries a commit's tree holds at `dirPath` ('' for the root), or null. */
  dirAt(
    repo: Repo,
    commitOid: string,
    dirPath: string,
  ): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size: number }> | null {
    const commit = repo.objects.get(peelToNonTag(this.lookup(repo), commitOid));
    if (!commit || commit.type !== 'commit') return null;
    const rootTree = parseCommit(commit.data).tree;
    let treeOid = rootTree;
    const segments = dirPath.split('/').filter((s) => s !== '');
    if (segments.length > 0) {
      const found = findTreePath(this.lookup(repo), rootTree, segments);
      if (!found || found.mode !== '40000') return null;
      treeOid = found.oid;
    }
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entries = parseTree(tree.data);
    return entries.map((entry) => {
      const isDir = entry.mode === '40000';
      const object = repo.objects.get(entry.oid);
      return {
        name: entry.name,
        path: segments.length === 0 ? entry.name : `${segments.join('/')}/${entry.name}`,
        type: isDir ? 'dir' : 'file',
        sha: entry.oid,
        size: isDir ? 0 : (object?.data.length ?? 0),
      };
    });
  }

  /** Commits reachable from `ref`, newest first. */
  listCommits(repo: Repo, ref: string | undefined, limit = 30): string[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    return commitHistory(this.lookup(repo), tip, limit);
  }

  // -------------------------------------------------------------------------
  // labels, issues, comments
  // -------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: readonly string[] }): Issue {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new ServiceError(422, `Label "${name}" does not exist`);
    }
    const seq = this.tick();
    const issue: Issue = {
      id: this.nextRestId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
      jsonCache: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw notFound(`Issue #${number}`);
    return issue;
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue {
    const issue = this.getIssue(repo, number);
    if (patch.state !== undefined) {
      if (patch.state !== 'open' && patch.state !== 'closed') {
        throw new ServiceError(422, `Invalid state ${JSON.stringify(patch.state)}`);
      }
      issue.state = patch.state;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedSeq = this.tick();
    issue.jsonCache = null;
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const issue = this.getIssue(repo, number);
    const comment: Comment = { id: this.nextRestId++, body, createdSeq: this.tick() };
    issue.comments.push(comment);
    issue.updatedSeq = this.tick();
    issue.jsonCache = null;
    return comment;
  }

  /** Issues filtered by state and ordered by creation (asc/desc by sequence). */
  listIssues(repo: Repo, state: string, direction: 'asc' | 'desc'): Issue[] {
    const all = [...repo.issues.values()];
    const filtered =
      state === 'all' ? all : all.filter((issue) => issue.state === (state === 'closed' ? 'closed' : 'open'));
    filtered.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return filtered;
  }

  // -------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------

  createPull(
    repo: Repo,
    input: { head: string; base: string; title: string; body?: string },
  ): Pull {
    const headTip = this.branchTip(repo, input.head);
    if (headTip === null) throw new ServiceError(422, `Head branch "${input.head}" does not exist`);
    const baseTip = this.branchTip(repo, input.base);
    if (baseTip === null) throw new ServiceError(422, `Base branch "${input.base}" does not exist`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        throw new ServiceError(422, 'A pull request already exists for this head and base.');
      }
    }
    const seq = this.tick();
    const pull: Pull = {
      id: this.nextRestId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headShaAtCreate: headTip,
      baseShaAtCreate: baseTip,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull {
    const pull = repo.pulls.get(number);
    if (!pull) throw notFound(`Pull request #${number}`);
    return pull;
  }

  /** The live head/base shas of a pull request (the branch tips, or the creation shas). */
  pullShas(repo: Repo, pull: Pull): { headSha: string; baseSha: string } {
    return {
      headSha: this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate,
      baseSha: this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate,
    };
  }

  /** The merge-base commit of a pull request, or null when the histories are unrelated. */
  pullMergeBase(repo: Repo, pull: Pull): string | null {
    const { headSha, baseSha } = this.pullShas(repo, pull);
    return mergeBase(this.lookup(repo), headSha, baseSha);
  }

  /** The file diff of a pull request (merge-base -> head). */
  pullFiles(repo: Repo, pull: Pull): DiffFile[] {
    const { headSha } = this.pullShas(repo, pull);
    const base = this.pullMergeBase(repo, pull);
    const lookup = this.lookup(repo);
    const headCommit = repo.objects.get(peelToNonTag(lookup, headSha));
    if (!headCommit || headCommit.type !== 'commit') return [];
    const headTree = parseCommit(headCommit.data).tree;
    if (base === null) {
      const emptyTree = this.putObject(repo, 'tree', buildTree([]));
      return diffTrees(lookup, emptyTree, headTree);
    }
    const baseCommit = repo.objects.get(base);
    if (!baseCommit || baseCommit.type !== 'commit') return [];
    return diffTrees(lookup, parseCommit(baseCommit.data).tree, headTree);
  }

  /** Whether a pull request merges cleanly (no path changed on both sides differently). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    return this.mergePreview(repo, pull).conflict === null;
  }

  /**
   * The three-way merge preview: the tree a squash merge would land, or the conflicting
   * path when the same file changed on both sides with different content.
   */
  mergePreview(repo: Repo, pull: Pull): { tree: string | null; conflict: string | null } {
    const lookup = this.lookup(repo);
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const baseCommitOid = this.pullMergeBase(repo, pull);
    const headCommit = repo.objects.get(peelToNonTag(lookup, headSha));
    const baseTipCommit = repo.objects.get(peelToNonTag(lookup, baseSha));
    if (!headCommit || headCommit.type !== 'commit' || !baseTipCommit || baseTipCommit.type !== 'commit') {
      return { tree: null, conflict: 'missing commit' };
    }
    const headTree = parseCommit(headCommit.data).tree;
    const baseTipTree = parseCommit(baseTipCommit.data).tree;
    let mergeBaseTree: string;
    if (baseCommitOid === null) {
      mergeBaseTree = this.putObject(repo, 'tree', buildTree([]));
    } else {
      const mergeBaseCommit = repo.objects.get(baseCommitOid);
      if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return { tree: null, conflict: 'missing merge-base' };
      mergeBaseTree = parseCommit(mergeBaseCommit.data).tree;
    }
    const ancestor = flattenTree(lookup, mergeBaseTree);
    const head = flattenTree(lookup, headTree);
    const tip = flattenTree(lookup, baseTipTree);
    const merged = new Map<string, { oid: string; mode: string }>(tip);
    const paths = new Set([...ancestor.keys(), ...head.keys()]);
    for (const path of paths) {
      const a = ancestor.get(path);
      const h = head.get(path);
      const t = tip.get(path);
      const headChanged = (h?.oid ?? null) !== (a?.oid ?? null) || (h?.mode ?? null) !== (a?.mode ?? null);
      const tipChanged = (t?.oid ?? null) !== (a?.oid ?? null) || (t?.mode ?? null) !== (a?.mode ?? null);
      if (!headChanged) continue;
      if (tipChanged && (h?.oid ?? null) !== (t?.oid ?? null)) {
        return { tree: null, conflict: path };
      }
      if (h === undefined) merged.delete(path);
      else merged.set(path, { oid: h.oid, mode: h.mode });
    }
    // Rebuild the merged tree from the flat map.
    const treeOid = this.buildTreeFromFlat(repo, merged);
    return { tree: treeOid, conflict: null };
  }

  /** Build a tree object from a flat path map, creating intermediate directories. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, number: number): { sha: string; pull: Pull } {
    const pull = this.getPull(repo, number);
    if (pull.state !== 'open' || pull.merged) {
      throw new ServiceError(405, 'Pull request is not mergeable');
    }
    const preview = this.mergePreview(repo, pull);
    if (preview.conflict !== null || preview.tree === null) {
      throw new ServiceError(405, `Merge conflict in ${preview.conflict ?? 'unknown path'}`);
    }
    const { baseSha } = this.pullShas(repo, pull);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree: preview.tree,
      parents: [peelToNonTag(this.lookup(repo), baseSha)],
      message,
      author: this.identity,
      committer: this.identity,
      timestamp: this.commitTimestamp(),
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = this.timestamp(this.tick());
    pull.updatedSeq = this.tick();
    return { sha, pull };
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const all = [...repo.pulls.values()];
    const filtered =
      state === 'all' ? all : state === 'closed' ? all.filter((p) => p.state === 'closed') : all.filter((p) => p.state === 'open');
    filtered.sort((a, b) => b.createdSeq - a.createdSeq);
    return filtered;
  }

  // -------------------------------------------------------------------------
  // serialization (REST shapes)
  // -------------------------------------------------------------------------

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.dbid,
      node_id: globalId('repo', repo.dbid),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      created_at: this.timestamp(repo.createdSeq),
      updated_at: this.timestamp(repo.createdSeq),
    };
  }

  labelJson(label: Label): Record<string, unknown> {
    return { id: hashLabelId(label.name), name: label.name, color: label.color, description: '' };
  }

  issueJson(repo: Repo, issue: Issue): string {
    if (issue.jsonCache !== null) return issue.jsonCache;
    const body = {
      id: issue.id,
      node_id: globalId('issue', repo.dbid, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => this.labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      comments: issue.comments.length,
      created_at: this.timestamp(issue.createdSeq),
      updated_at: this.timestamp(issue.updatedSeq),
    };
    issue.jsonCache = JSON.stringify(body);
    return issue.jsonCache;
  }

  /** The issue as an object (for embedding in other responses). */
  issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
    return JSON.parse(this.issueJson(repo, issue)) as Record<string, unknown>;
  }

  commentJson(comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: globalId('comment', comment.id),
      body: comment.body,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      created_at: this.timestamp(comment.createdSeq),
      updated_at: this.timestamp(comment.createdSeq),
    };
  }

  pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
    const { headSha, baseSha } = this.pullShas(repo, pull);
    return {
      id: pull.id,
      node_id: globalId('pr', repo.dbid, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      mergeable: pull.state === 'open' ? this.pullMergeable(repo, pull) : null,
      head: {
        ref: pull.headRef,
        sha: headSha,
        label: `${repo.owner}:${pull.headRef}`,
        repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
      },
      base: {
        ref: pull.baseRef,
        sha: baseSha,
        label: `${repo.owner}:${pull.baseRef}`,
        repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
      },
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      created_at: this.timestamp(pull.createdSeq),
      updated_at: this.timestamp(pull.updatedSeq),
    };
  }

  /** The added/removed line counts of one pull-request file. */
  pullFileCounts(repo: Repo, file: DiffFile): { additions: number; deletions: number } {
    const lookup = this.lookup(repo);
    const oldData = file.oldOid === null ? null : (lookup(file.oldOid)?.data ?? null);
    const newData = file.newOid === null ? null : (lookup(file.newOid)?.data ?? null);
    return lineDiff(oldData, newData);
  }

  /** One pull-request file with its change counts. */
  pullFileJson(repo: Repo, file: DiffFile): Record<string, unknown> {
    const { additions, deletions } = this.pullFileCounts(repo, file);
    return {
      sha: file.newOid ?? file.oldOid ?? ZERO_OID,
      filename: file.path,
      status: file.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  }

  commitJson(repo: Repo, oid: string): Record<string, unknown> {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return { sha: oid, commit: { message: '' } };
    const commit = parseCommit(object.data);
    const authorDate = commitDate(commit.author);
    const committerDate = commitDate(commit.committer);
    return {
      sha: oid,
      commit: {
        // The stored message ends with a newline (git's convention); the REST
        // surface answers it the way GitHub does, without the trailing newline.
        message: commit.message.replace(/\n+$/, ''),
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: authorDate },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: committerDate },
      },
      parents: commit.parents.map((sha) => ({ sha })),
    };
  }
}

/** The ISO date of a `Name <email> <unix> <tz>` identity line. */
function commitDate(identity: string): string {
  const match = / (\d+) [+-]\d{4}$/.exec(identity);
  const seconds = match ? Number(match[1]) : EPOCH_SEC;
  return new Date(seconds * 1000).toISOString();
}

/** A stable integer id for a label name (labels have no REST id counter of their own). */
function hashLabelId(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483647;
}

// ---------------------------------------------------------------------------
// global (Relay) ids: opaque, stable, decodable
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    // Re-encode to reject strings that merely decode to something with colons.
    if (Buffer.from(text, 'utf8').toString('base64url') !== id) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** True when `ancestor` is an ancestor of `descendant` in this repo (re-exported helper). */
export function repoIsAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  return isAncestor((oid) => repo.objects.get(oid), ancestor, descendant);
}
