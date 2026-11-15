// githttp.ts — git smart HTTP: info/refs advertisements (v0 and v2), upload-pack
// (protocol v2 ls-refs/fetch, v0 fetch) and receive-pack (v0 push with fast-forward
// checks and report-status). The object store lives in the Forge; this file only
// frames the protocol.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isAncestor,
  isObjectId,
  packetLines,
  peelToNonTag,
  planFetch,
  readPack,
  sidebandPack,
  writePack,
  GitError,
} from './gitcore.ts';
import { Forge, ServiceError, VIEWER_LOGIN, type Repo } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V0_UPLOAD_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson404(res: ServerResponse, what: string): void {
  const text = JSON.stringify({ message: `${what} not found` });
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBadRequest(res: ServerResponse, message: string): void {
  const text = JSON.stringify({ message });
  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** The repo a git request names, or null when the owner is not the viewer or it is absent. */
function gitRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}

/** Refs sorted the way an advertisement lists them: HEAD first, then refs in order. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The peeled (non-tag) target of a ref, or null when it is not an annotated tag. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  try {
    return peelToNonTag((id) => repo.objects.get(id), oid);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : RECEIVE_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  lines.push(`${headOid} HEAD\0${caps}\n`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\n`);
  } else {
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow ofs-delta\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  forge: Forge,
  owner: string,
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): void {
  const repo = gitRepo(forge, owner, name);
  if (repo === null) {
    sendJson404(res, `Repository ${owner}/${name}`);
    return;
  }
  const service = query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBadRequest(res, 'a service parameter is required');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    send(res, 200, UPLOAD_AD, v2Advertisement());
    return;
  }
  send(res, 200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, v0Advertisement(repo, service));
}

// ---------------------------------------------------------------------------
// protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------

interface V2Command {
  readonly command: string;
  readonly args: string[];
}

/** Parse a v2 command request body into its command and argument lines. */
function parseV2Command(body: Buffer): V2Command {
  const { packets } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= and object-format= lines are acknowledged and ignored.
    } else if (line !== '') {
      args.push(line);
    }
  }
  if (command === '') throw new GitError('a v2 request names no command', 'v2-command');
  return { command, args };
}

function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix\t')) prefixes.push(arg.slice('ref-prefix\t'.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (symrefs && keep('HEAD')) {
    if (headOid === undefined) {
      if (unborn) lines.push(`unborn HEAD symref-target:${headTarget}\n`);
    } else {
      lines.push(`${headOid} HEAD symref-target:${headTarget}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const depth = Number(arg.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) out.depth = Math.trunc(depth);
    } else if (arg === 'done') out.done = true;
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted
    // and ignored — this server sends full objects and no progress.
  }
  return out;
}

function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const fetch = parseFetchArgs(args);
  const plan = planFetch(
    (oid) => repo.objects.get(oid),
    fetch.wants,
    fetch.haves,
    fetch.shallow,
    fetch.depth,
  );
  const parts: Buffer[] = [];
  // acknowledgments — only when the client sent haves. A client with no haves
  // never reads this section: it goes straight to shallow-info/packfile, and an
  // unexpected "acknowledgments" header there is a fatal protocol error.
  if (fetch.haves.length > 0) {
    const ackLines: Array<string | 'flush'> = ['acknowledgments\n'];
    if (plan.acks.length === 0) ackLines.push('NAK\n');
    else {
      for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
    }
    if (fetch.done) ackLines.push('ready\n');
    ackLines.push('flush');
    parts.push(encodePktLines(ackLines));
  }
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('flush');
    parts.push(encodePktLines(shallowLines));
  }
  // packfile — always, even when the client already holds everything: an empty
  // pack (zero objects) is the wire's way of saying "nothing new".
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandPack(writePack(plan.send)));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack (v2 when Git-Protocol: version=2). */
export function handleUploadPack(
  forge: Forge,
  owner: string,
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const repo = gitRepo(forge, owner, name);
  if (repo === null) {
    sendJson404(res, `Repository ${owner}/${name}`);
    return;
  }
  try {
    if ((req.headers['git-protocol'] ?? '').includes('version=2')) {
      const { command, args } = parseV2Command(body);
      if (command === 'ls-refs') {
        send(res, 200, UPLOAD_RESULT, handleLsRefs(repo, args));
        return;
      }
      if (command === 'fetch') {
        send(res, 200, UPLOAD_RESULT, handleFetchV2(repo, args));
        return;
      }
      sendBadRequest(res, `unknown v2 command ${JSON.stringify(command)}`);
      return;
    }
    send(res, 200, UPLOAD_RESULT, handleFetchV0(repo, body));
  } catch (err) {
    if (err instanceof GitError) {
      sendBadRequest(res, err.message);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// protocol v0 fetch
// ---------------------------------------------------------------------------

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  // Two sections: wants (with shallow/deepen) terminated by a flush, then the
  // negotiation (have lines and done) terminated by a second flush.
  const first = decodePktLines(body);
  const second = decodePktLines(body, first.next);
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const line of packetLines(first.packets)) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\0');
      fetch.wants.push((nul < 0 ? rest : rest.slice(0, nul)).trim());
    } else if (line.startsWith('shallow ')) {
      fetch.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) fetch.depth = Math.trunc(depth);
    }
  }
  for (const line of packetLines(second.packets)) {
    if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    else if (line === 'done') fetch.done = true;
  }
  const plan = planFetch(
    (oid) => repo.objects.get(oid),
    fetch.wants,
    fetch.haves,
    fetch.shallow,
    fetch.depth,
  );
  const parts: Buffer[] = [];
  const lines: Array<string | 'flush'> = [];
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  if (plan.acks.length === 0) lines.push('NAK\n');
  else {
    for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
  }
  parts.push(encodePktLines(lines));
  // The pack follows even when it is empty: a zero-object pack is "nothing new".
  parts.push(sidebandPack(writePack(plan.send)));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer } {
  const { packets, next } = decodePktLines(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index];
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0 || commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const token of line.slice(nul + 1).split(' ')) {
          if (token !== '') capabilities.add(token.split('=')[0]);
        }
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) throw new GitError(`bad push command ${JSON.stringify(line.slice(0, 80))}`, 'push-command');
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  return { commands, capabilities, pack: body.subarray(next) };
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(
  forge: Forge,
  owner: string,
  name: string,
  _req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const repo = gitRepo(forge, owner, name);
  if (repo === null) {
    sendJson404(res, `Repository ${owner}/${name}`);
    return;
  }
  try {
    const { commands, capabilities, pack } = parsePushCommands(body);
    if (commands.length === 0) throw new GitError('a push needs at least one command', 'push-command');
    const sideband = capabilities.has('side-band-64k');

    // Unpack first: the objects land even when a ref update is refused.
    let unpackDetail = 'ok';
    if (pack.length > 0) {
      try {
        const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackDetail = err instanceof Error ? err.message : 'unpacker error';
      }
    }

    const reportLines: string[] = [];
    if (unpackDetail === 'ok') {
      reportLines.push('unpack ok\n');
    } else {
      reportLines.push(`unpack ${unpackDetail}\n`);
    }
    for (const command of commands) {
      if (unpackDetail !== 'ok') {
        reportLines.push(`ng ${command.ref} unpacker error\n`);
        continue;
      }
      const verdict = applyPushCommand(forge, repo, command);
      reportLines.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
    }

    if (sideband) {
      // The report-status stream is itself pkt-lined inside band 1 — including
      // its own flush, which the demuxed reader needs to end the report; the
      // outer sideband stream then ends with a second, outer flush.
      const parts: Buffer[] = [];
      for (const line of [...reportLines, 'flush' as const]) {
        const framed = encodePktLines([line]);
        const payload = Buffer.concat([Buffer.from([1]), framed]);
        const length = payload.length + 4;
        parts.push(Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'));
        parts.push(payload);
      }
      parts.push(encodePktLines(['flush']));
      send(res, 200, RECEIVE_RESULT, Buffer.concat(parts));
      return;
    }
    send(res, 200, RECEIVE_RESULT, encodePktLines([...reportLines, 'flush']));
  } catch (err) {
    if (err instanceof GitError) {
      sendBadRequest(res, err.message);
      return;
    }
    throw err;
  }
}

/**
 * Apply one push command. Returns null on success, or the ng reason on refusal.
 * A refusal never moves the ref.
 */
function applyPushCommand(forge: Forge, repo: Repo, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/')) return 'invalid ref';
  const current = repo.refs.get(ref);
  if (current === undefined) {
    if (oldOid !== ZERO_OID) return 'old value mismatch';
  } else if (current !== oldOid) {
    return 'old value mismatch';
  }
  if (newOid === ZERO_OID) {
    // Delete.
    repo.refs.delete(ref);
    return null;
  }
  const object = repo.objects.get(newOid);
  if (!object) return 'missing object';
  if (oldOid === ZERO_OID) {
    // Create.
    repo.refs.set(ref, newOid);
    return null;
  }
  // Update: must fast-forward (the old tip is an ancestor of the new tip).
  void forge;
  try {
    const lookup = (oid: string) => repo.objects.get(oid);
    const oldPeeled = peelToNonTag(lookup, oldOid);
    const newPeeled = peelToNonTag(lookup, newOid);
    if (oldPeeled === newPeeled) {
      repo.refs.set(ref, newOid);
      return null;
    }
    if (!isObjectId(oldPeeled) || !isObjectId(newPeeled)) return 'non-fast-forward';
    if (isAncestor(lookup, oldPeeled, newPeeled)) {
      repo.refs.set(ref, newOid);
      return null;
    }
    return 'non-fast-forward';
  } catch (err) {
    if (err instanceof GitError) return 'non-fast-forward';
    throw err;
  }
}

/** Re-export for the router: the git path prefix test. */
export function gitPathOf(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const rest = match[3] ?? '';
  return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]), rest: rest.replace(/^\//, '') };
}

export { ServiceError };
