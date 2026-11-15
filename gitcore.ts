// gitcore.ts — the git object model, pkt-line codec, packfile read/write, traversal,
// fetch planning and tree diffing. No I/O here: every function works on Buffers and Maps,
// so the HTTP layer stays thin and the same code serves smart HTTP, the REST contents API
// and pull-request diffs.
//
// The formats implemented are git's own (loose object hashing, packfile v2, pkt-line
// framing, delta application), written from the format's specification.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return OID_RE.test(value);
}

/** A thrown git error with a short machine-readable code. */
export class GitError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

/** SHA-1 over `<type> <size>\0` + bytes: the object id git assigns. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries (mode SP name NUL 20-byte oid, repeated). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new GitError('tree entry has no mode', 'tree-parse');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new GitError('tree entry is truncated', 'tree-parse');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Compare two tree entry names the way git sorts them: byte order, with a directory
 * compared as if its name ended in '/'.
 */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === '40000' ? `${a.name}/` : a.name;
  const bName = b.mode === '40000' ? `${b.name}/` : b.name;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/** Build a tree object's bytes from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new GitError(`tree entry ${entry.name} has a bad object id`, 'tree-build');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new GitError('commit has no valid tree header', 'commit-parse');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new GitError('commit has a bad parent id', 'commit-parse');
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
  readonly timezone?: string;
}

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new GitError('buildCommit needs a valid tree id', 'commit-build');
  const timezone = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new GitError('buildCommit needs valid parent ids', 'commit-build');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${fields.author} ${fields.timestamp} ${timezone}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${timezone}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitError(`tag header ${JSON.stringify(line)} has no value`, 'tag-parse');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new GitError('tag has no valid object header', 'tag-parse');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitError(`tag has bad type ${JSON.stringify(type)}`, 'tag-parse');
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel tag objects to the first non-tag object they point at. */
export function peelToNonTag(lookup: ObjectLookup, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) throw new GitError('tag cycle', 'tag-peel');
    seen.add(current);
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export type PktLine = string | 'flush' | 'delim' | 'response-end';

export interface GitPacket {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  readonly payload: Buffer;
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');

/** Encode lines into pkt-line framing. */
export function encodePktLines(lines: readonly PktLine[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') {
      parts.push(PKT_FLUSH);
    } else if (line === 'delim') {
      parts.push(Buffer.from('0001', 'ascii'));
    } else if (line === 'response-end') {
      parts.push(Buffer.from('0002', 'ascii'));
    } else {
      const payload = Buffer.from(line, 'utf8');
      const length = payload.length + 4;
      if (length > 65520) throw new GitError(`pkt-line of ${length} bytes exceeds the 65520 limit`, 'pkt-line');
      parts.push(Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'));
      parts.push(payload);
    }
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the start of `buffer`. Stops at the first flush (inclusive) or
 * at the end of the buffer. Returns the packets and the offset just past them, so a
 * caller can treat the rest (a packfile) as raw bytes.
 */
export function decodePktLines(buffer: Buffer, start = 0): { packets: GitPacket[]; next: number } {
  const packets: GitPacket[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new GitError('pkt-line header is truncated', 'pkt-line');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GitError(`bad pkt-line length ${JSON.stringify(hex)}`, 'pkt-line');
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, next: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new GitError('pkt-line is truncated', 'pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** The data payloads of decoded packets as text lines (without trailing newlines). */
export function packetLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split pack bytes into sideband band-1 pkt-lines (each at most 65520 bytes total). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 65520 - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const length = payload.length + 4;
    parts.push(Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'));
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new GitError('delta size varint is truncated', 'delta-corrupt');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new GitError(`delta expects a ${sourceSize}-byte base, got ${base.length}`, 'delta-base-size');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy offset is truncated', 'delta-corrupt');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy size is truncated', 'delta-corrupt');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new GitError('delta copy is out of the base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new GitError('delta writes past its target size', 'delta-corrupt');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new GitError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new GitError('delta writes past its target size', 'delta-corrupt');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) throw new GitError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  return out;
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new GitError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`, 'pack-zlib');
  return { data: result.buffer, next: offset + written };
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base object a thin pack leaves out. Every object's
 * SHA-1 is recomputed and its declared size checked.
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 32) throw new GitError(`pack is ${pack.length} bytes, too short`, 'pack-truncated');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack does not start with PACK', 'pack-header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`, 'pack-version');
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new GitError('pack trailer does not match its bytes', 'pack-checksum');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new GitError('pack entry has no size header', 'pack-truncated');
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new GitError('pack entry size varint is truncated', 'pack-truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new GitError('pack entry size varint is too long', 'pack-corrupt');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new GitError('ofs-delta has no base offset', 'pack-truncated');
      let deltaByte = pack[offset];
      offset += 1;
      let value = deltaByte & 0x7f;
      while (deltaByte & 0x80) {
        if (offset >= trailerStart) throw new GitError('ofs-delta base offset is truncated', 'pack-truncated');
        deltaByte = pack[offset++];
        value = ((value + 1) * 128) + (deltaByte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) {
        throw new GitError(`ofs-delta at ${entryOffset} names an invalid base offset ${value}`, 'pack-delta');
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitError('ref-delta base id is truncated', 'pack-truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitError(`pack entry ${index} has unknown type code ${typeCode}`, 'pack-type');
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) {
      throw new GitError(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`, 'pack-size');
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new GitError(`pack has ${trailerStart - offset} stray bytes before its trailer`, 'pack-trailing');
  }

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitError(`delta cycle at pack offset ${entry.offset}`, 'pack-delta-cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new GitError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`, 'pack-delta-base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) {
          throw new GitError(`ref-delta base ${wanted} is neither in the pack nor on the server`, 'pack-delta-base');
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). The trailer is SHA-1 over the rest. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// traversal
// ---------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped), tag -> its target, blob -> nothing. Throws on a missing object
 * unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new GitError(`object ${oid} is missing from the store`, 'missing-object');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its commit ancestors. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [peelToNonTag(lookup, descendant)];
  const target = peelToNonTag(lookup, ancestor);
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * The merge-base of two commits: the first common ancestor found walking from `b`
 * breadth-first over the ancestor set of `a`. Exact for linear histories, which is
 * what every pull request in the suite has.
 */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const aPeeled = peelToNonTag(lookup, a);
  const bPeeled = peelToNonTag(lookup, b);
  const ancestorsOfA = new Set<string>();
  const queueA = [aPeeled];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const seenB = new Set<string>();
  const queueB = [bPeeled];
  let headB = 0;
  while (headB < queueB.length) {
    const oid = queueB[headB++]!;
    if (ancestorsOfA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Commits reachable from `tip`, newest first (parents after children). */
export function commitHistory(lookup: ObjectLookup, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [peelToNonTag(lookup, tip)];
  let head = 0;
  while (head < queue.length && out.length < limit) {
    const oid = queue[head++]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in traversal order (commits, then trees, then blobs). */
  readonly send: GitObject[];
  /** The new shallow boundary commits (at the depth cut). */
  readonly shallow: string[];
  /** Old shallow boundaries whose parent is now sent. */
  readonly unshallow: string[];
  /** Haves that are ancestors of (or equal to) a want. */
  readonly acks: string[];
}

/**
 * Plan a fetch: what to send given what the client wants, has, and already holds
 * shallow. `depth` counts commit generations from the wants (1 = the tips only).
 */
export function planFetch(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);

  // What the client already holds: the closure of its haves, cut at its shallow
  // boundaries (a shallow commit's parents are NOT held).
  const haveSet = new Set<string>();
  {
    const queue: string[] = [...haves];
    while (queue.length) {
      const oid = queue.pop()!;
      if (haveSet.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      haveSet.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }

  // What the wants reach, with the depth cut and the have cut-off. BFS by commit
  // generation so the first visit is the shortest path from a want.
  const wantSet = new Set<string>();
  const boundaries = new Set<string>();
  const commitGeneration = new Map<string, number>();
  {
    const queue: Array<{ oid: string; generation: number }> = [];
    for (const want of wants) {
      if (!isObjectId(want)) continue;
      const object = lookup(want);
      if (!object) continue;
      if (object.type === 'tag') {
        // A wanted tag ships with its target at generation 1.
        queue.push({ oid: want, generation: 0 });
      } else if (object.type === 'commit') {
        queue.push({ oid: want, generation: 1 });
      } else {
        queue.push({ oid: want, generation: 0 });
      }
    }
    const queuedCommits = new Set<string>();
    // An index cursor, not shift(): the queue is a FIFO over a deep history and
    // shift() would make the traversal quadratic.
    let head = 0;
    while (head < queue.length) {
      const { oid, generation } = queue[head++]!;
      if (wantSet.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      wantSet.add(oid);
      if (object.type === 'commit') {
        const known = commitGeneration.get(oid);
        if (known === undefined || generation < known) commitGeneration.set(oid, generation);
        const commit = parseCommit(object.data);
        queue.push({ oid: commit.tree, generation: 0 });
        // Already held with its history: do not walk past it. A shallow boundary is
        // held WITHOUT its parents, so a deepen must still walk through it.
        if (haveSet.has(oid) && !shallowSet.has(oid)) continue;
        if (depth !== undefined && generation >= depth) {
          boundaries.add(oid);
          continue;
        }
        for (const parent of commit.parents) {
          if (!queuedCommits.has(parent)) {
            queuedCommits.add(parent);
            queue.push({ oid: parent, generation: generation + 1 });
          }
        }
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetObject = lookup(target);
        if (targetObject?.type === 'commit') {
          if (!queuedCommits.has(target)) {
            queuedCommits.add(target);
            queue.push({ oid: target, generation: 1 });
          }
        } else {
          queue.push({ oid: target, generation: 0 });
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push({ oid: entry.oid, generation: 0 });
        }
      }
    }
  }

  // The send set, in a stable order: commits first (shallowest generation first),
  // then trees, then blobs, then tags; ties by oid so two runs send identical packs.
  const sendOids = [...wantSet].filter((oid) => !haveSet.has(oid));
  const byType = (oid: string): number => {
    const type = lookup(oid)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3;
  };
  sendOids.sort((a, b) => {
    const typeDiff = byType(a) - byType(b);
    if (typeDiff !== 0) return typeDiff;
    if (byType(a) === 0) {
      const genDiff = (commitGeneration.get(a) ?? 0) - (commitGeneration.get(b) ?? 0);
      if (genDiff !== 0) return genDiff;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const send: GitObject[] = [];
  for (const oid of sendOids) {
    const object = lookup(oid);
    if (object) send.push(object);
  }
  const sendSet = new Set(sendOids);

  const shallow = [...boundaries].filter((oid) => sendSet.has(oid)).sort();
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (!wantSet.has(boundary) && !haveSet.has(boundary)) continue;
    const object = lookup(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => sendSet.has(parent))) unshallow.push(boundary);
  }
  unshallow.sort();

  // ACKs: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (!isObjectId(have)) continue;
    if (wantSet.has(have)) {
      acks.push(have);
      continue;
    }
    let common = false;
    for (const want of wants) {
      if (isObjectId(want) && lookup(want)?.type === 'commit' && isAncestor(lookup, have, want)) {
        common = true;
        break;
      }
    }
    if (common) acks.push(have);
  }
  return { send, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------
// trees as flat file maps, and diffs
// ---------------------------------------------------------------------------

export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** A tree flattened to path -> entry (gitlinks kept as entries, never followed). */
export function flattenTree(lookup: ObjectLookup, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

export interface DiffFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(lookup: ObjectLookup, baseTree: string, headTree: string): DiffFile[] {
  const base = flattenTree(lookup, baseTree);
  const head = flattenTree(lookup, headTree);
  const files: DiffFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry && !newEntry) {
      files.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (!oldEntry && newEntry) {
      files.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry && newEntry && (oldEntry.oid !== newEntry.oid || oldEntry.mode !== newEntry.mode)) {
      files.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return files;
}

/** Count the lines of a blob the way a diff does (a trailing newline adds no line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === 0x0a) count += 1;
  }
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

/**
 * Added/deleted line counts between two blobs. A longest-common-subsequence diff on
 * lines for small files; a multiset estimate when the files are too large for the DP.
 */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: countLines(newData!), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: countLines(oldData) };
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length * newLines.length > 250_000) {
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const left = oldCounts.get(line) ?? 0;
      if (left > 0) {
        oldCounts.set(line, left - 1);
        common += 1;
      }
    }
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }
  // LCS lengths, two rows.
  let previous = new Array<number>(newLines.length + 1).fill(0);
  let current = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    current[0] = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      current[j] =
        oldLines[i - 1] === newLines[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  const common = previous[newLines.length];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/**
 * A tree with `path` set to `blobOid` (or removed when `blobOid` is null), every other
 * entry kept. New objects are written through `put`; returns the new root tree oid.
 */
export function treeWithPath(
  lookup: ObjectLookup,
  put: (type: GitObjectType, data: Buffer) => string,
  treeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
): string {
  const head = segments[0];
  if (head === undefined || head === '' || head === '.' || head === '..') {
    throw new GitError('the file path has an unusable segment', 'tree-path');
  }
  const rest = segments.slice(1);
  const entries: TreeEntry[] =
    treeOid === null ? [] : parseTree(lookup(treeOid)?.data ?? Buffer.alloc(0));
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childOid = treeWithPath(lookup, put, existing?.oid ?? null, rest, blobOid);
    // Drop the directory when it becomes empty.
    const childEntries = parseTree(lookup(childOid)?.data ?? Buffer.alloc(0));
    if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: childOid });
  }
  return put('tree', buildTree(kept));
}

/** The blob (or subtree) a tree holds at `segments`, or null when the path is absent. */
export function findTreePath(
  lookup: ObjectLookup,
  treeOid: string,
  segments: readonly string[],
): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}
