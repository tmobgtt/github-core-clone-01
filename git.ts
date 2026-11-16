// The git layer: the object model (blob/tree/commit/tag over SHA-1), packfile reading and
// writing, pkt-line framing, the smart-HTTP protocol (info/refs, upload-pack v0 and v2 with
// ls-refs and fetch, receive-pack v0 with report-status), and the tree diff / three-way merge
// the pull-request surface is built on. Standard library only: node:crypto for SHA-1 and
// node:zlib for pack compression. No git binary exists at run time; this is the whole engine.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Store, VIEWER, type GitObject, type GitObjectType, type Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
export const AGENT = 'forge/1.0.0';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 of two buffers in sequence, without copying either into a joined buffer. */
export function sha1HexOf(head: Buffer, tail: Buffer): string {
  return createHash('sha1').update(head).update(tail).digest('hex');
}

/** Hash an object into the store (or just compute its id when `write` is false). */
export function hashObject(store: Store, type: GitObjectType, data: Buffer, write = true): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = sha1HexOf(header, data);
  if (write && !store.objects.has(sha)) store.objects.set(sha, { type, data });
  return sha;
}

export function getObject(store: Store, sha: string): GitObject | null {
  return store.objects.get(sha) ?? null;
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('utf8', offset, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A flattened tree: path -> the leaf entry there (blob or gitlink). */
export type FlatTree = Map<string, { mode: string; sha: string }>;

export function flattenTree(store: Store, treeSha: string, prefix = '', out: FlatTree = new Map()): FlatTree {
  const tree = getObject(store, treeSha);
  if (tree === null || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

/** Rebuild a tree object (recursively) from a flattened path map; returns the tree's id. */
export function buildTreeFromFlat(store: Store, flat: FlatTree): string {
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: emit(dir) });
    return hashObject(store, 'tree', buildTreeData(entries));
  };
  return emit(root);
}

/** Resolve a path inside a tree: the entry it names, or null. */
export function treeEntryAt(store: Store, treeSha: string, path: string): { mode: string; sha: string } | null {
  if (path === '' || path === '/') return { mode: '40000', sha: treeSha };
  const parts = path.split('/');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = getObject(store, current);
    if (tree === null || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { mode: entry.mode, sha: entry.sha };
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

// ------------------------------------------------------------------ commits and tags

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const commit: Commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export function buildCommitData(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** The forge's own identity line for commits it creates (contents writes, merges). */
export function forgeIdentity(sec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
}

/** Create a commit object with the forge identity at the store's logical time. */
export function createCommit(store: Store, tree: string, parents: string[], message: string): string {
  const identity = forgeIdentity(store.tickSec());
  return hashObject(store, 'commit', buildCommitData({ tree, parents, author: identity, committer: identity, message }));
}

/** Follow tag objects to the commit they ultimately name; null when the chain ends elsewhere. */
export function peelToCommit(store: Store, sha: string, extra?: Map<string, GitObject>): string | null {
  let current = sha;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = extra?.get(current) ?? getObject(store, current);
    if (object === null || object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/** Peel any object to the object a tag chain ends at (used for ls-refs peeled lines). */
export function peelFully(store: Store, sha: string): string {
  let current = sha;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = getObject(store, current);
    if (object === null || object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

/** Every commit reachable from `tip`, with its generation (shortest distance; the tip is 1). */
export function commitGenerations(store: Store, tip: string, extra?: Map<string, GitObject>): Map<string, number> {
  const generations = new Map<string, number>();
  const start = peelToCommit(store, tip, extra);
  if (start === null) return generations;
  // A head-index queue, not shift(): the walks below run per fetch and per push, and a
  // shift-based queue makes each of them quadratic in the history length.
  const queue: Array<{ sha: string; gen: number }> = [{ sha: start, gen: 1 }];
  generations.set(start, 1);
  for (let head = 0; head < queue.length; head += 1) {
    const { sha, gen } = queue[head] as { sha: string; gen: number };
    const object = extra?.get(sha) ?? getObject(store, sha);
    if (object === null || object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!generations.has(parent)) {
        generations.set(parent, gen + 1);
        queue.push({ sha: parent, gen: gen + 1 });
      }
    }
  }
  return generations;
}

/**
 * Whether `ancestor` is reachable from `descendant`, with an early exit the moment it is
 * found: a fast-forward check on a push usually resolves at the new tip's first parent, and
 * walking the whole history for every push made the push workload quadratic.
 */
export function isAncestor(store: Store, ancestor: string, descendant: string, extra?: Map<string, GitObject>): boolean {
  const start = peelToCommit(store, descendant, extra);
  if (start === null) return false;
  if (start === ancestor) return true;
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const sha = queue[head] as string;
    const object = extra?.get(sha) ?? getObject(store, sha);
    if (object === null || object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The best common ancestor of two commits: a common commit no other common commit descends from. */
export function mergeBase(store: Store, a: string, b: string): string | null {
  const fromA = commitGenerations(store, a);
  const fromB = commitGenerations(store, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [sha, genA] of fromA) {
    const genB = fromB.get(sha);
    if (genB === undefined) continue;
    const score = Math.max(genA, genB) + genA + genB;
    if (score < bestScore) {
      bestScore = score;
      best = sha;
    }
  }
  return best;
}

/** History from a tip, newest first: depth-first, parents in order, each commit once. */
export function historyFrom(store: Store, tip: string, limit: number): string[] {
  const start = peelToCommit(store, tip);
  if (start === null) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [start];
  while (stack.length > 0 && order.length < limit) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    order.push(sha);
    const object = getObject(store, sha);
    if (object === null || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return order;
}

// ------------------------------------------------------------------ diff and merge

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/** Line-level add/delete counts between two blob texts (LCS; a coarse fallback for huge files). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const width = newLines.length + 1;
  let prev = new Uint32Array(width);
  let curr = new Uint32Array(width);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const common = prev[newLines.length] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function blobText(store: Store, sha: string | undefined): string {
  if (sha === undefined) return '';
  const object = getObject(store, sha);
  return object === null ? '' : object.data.toString('utf8');
}

/** The changes between two flattened trees, with per-file line counts. */
export function diffFlats(store: Store, base: FlatTree, head: FlatTree): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha && before.mode === after.mode) continue;
    if (before === undefined && after !== undefined) {
      changes.push({ path, status: 'added', additions: countLines(blobText(store, after.sha)), deletions: 0 });
    } else if (after === undefined && before !== undefined) {
      changes.push({ path, status: 'removed', additions: 0, deletions: countLines(blobText(store, before.sha)) });
    } else if (before !== undefined && after !== undefined) {
      const counts = lineDiffCounts(blobText(store, before.sha), blobText(store, after.sha));
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

/** A path-level three-way merge: a path changed on both sides to different entries conflicts. */
export function mergeFlats(base: FlatTree, ours: FlatTree, theirs: FlatTree): { merged: FlatTree; conflicts: string[] } {
  const merged: FlatTree = new Map();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: { mode: string; sha: string } | undefined, y: { mode: string; sha: string } | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.sha === y.sha && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

// ------------------------------------------------------------------ pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Parse as many pkt-lines as `buffer` holds from `offset`; returns them and the next offset. */
export function parsePkts(buffer: Buffer, offset = 0): { pkts: Pkt[]; next: number } {
  const pkts: Pkt[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const header = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`bad pkt-line header at ${at}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      pkts.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      pkts.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      pkts.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) throw new Error(`pkt-line at ${at} overruns the body`);
    pkts.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { pkts, next: at };
}

/**
 * Split a receive-pack body into its command pkt-lines and the raw pack after them. Parsing
 * stops at the first flush: everything past it is pack bytes, not pkt-lines.
 */
export function splitPktBody(body: Buffer): { pkts: Pkt[]; rest: Buffer } {
  const pkts: Pkt[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const header = body.toString('ascii', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`bad pkt-line header at ${at}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      pkts.push({ kind: 'flush' });
      at += 4;
      return { pkts, rest: body.subarray(at) };
    }
    if (length === 1) {
      pkts.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      pkts.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) throw new Error(`pkt-line at ${at} overruns the body`);
    pkts.push({ kind: 'data', payload: body.subarray(at + 4, at + length) });
    at += length;
  }
  return { pkts, rest: body.subarray(at) };
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack holding the named objects whole (no deltas), with a SHA-1 trailer. */
export function writePack(store: Store, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const object = getObject(store, sha);
    if (object === null) continue;
    parts.push(packEntryHeader(object.type, object.data.length));
    // Level 1: packs are verified by checksum, not admired for their ratio, and the fetch
    // workloads are timed — cheap compression beats small packs on a loopback link.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[at++] as number;
      if (op & 0x02) copyOffset |= (delta[at++] as number) << 8;
      if (op & 0x04) copyOffset |= (delta[at++] as number) << 16;
      if (op & 0x08) copyOffset |= (delta[at++] as number) << 24;
      if (op & 0x10) copySize |= delta[at++] as number;
      if (op & 0x20) copySize |= (delta[at++] as number) << 8;
      if (op & 0x40) copySize |= (delta[at++] as number) << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Parse a pack into objects, resolving OFS_DELTA and REF_DELTA entries. A REF_DELTA base may
 * come from `external` (the store) for thin packs. Throws on anything malformed.
 */
export function parsePack(pack: Buffer, external?: (sha: string) => GitObject | null): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++] as number;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++] as number;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++] as number;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, GitObject>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | null;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry);
      } else {
        base = resolvedByOid.get(entry.baseOid as string) ?? external?.(entry.baseOid as string) ?? null;
        if (base === null) throw new Error('ref-delta base missing');
      }
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    return { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
  };
  for (const entry of raw) {
    const object = resolve(entry);
    const header = Buffer.from(`${object.type} ${object.data.length}\0`, 'utf8');
    const sha = sha1HexOf(header, object.data);
    objects.set(sha, object);
    resolvedByOid.set(sha, object);
  }
  return objects;
}

// ------------------------------------------------------------------ ref advertisement

export interface HandlerResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** GET info/refs for a service. `protocol2` is the Git-Protocol: version=2 request header. */
export function infoRefs(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocol2: boolean): HandlerResult {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocol2) {
    // The v2 advertisement names no refs: the same bytes serve every repository.
    const held = refAnswers.get('info-v2-upload');
    if (held !== undefined) return held;
    const lines = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    return rememberAnswer(refAnswers, 'info-v2-upload', { status: 200, contentType, body: Buffer.concat(lines) });
  }
  const cacheKey = `info\n${refsFingerprint(repo)}\n${service}\n${protocol2 ? 'v2' : 'v0'}`;
  const cached = refAnswers.get(cacheKey);
  if (cached !== undefined) return cached;
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const target = getObject(store, oid);
      if (target !== null && target.type === 'tag') {
        parts.push(pktLine(`${peelFully(store, oid)} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return rememberAnswer(refAnswers, cacheKey, { status: 200, contentType, body: Buffer.concat(parts) });
}

// ------------------------------------------------------------------ fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/** One commit's own payload: the commit and its full tree, but NOT its ancestors. A shallow
 *  pack is built from these per included commit, so a boundary commit's parents never leak
 *  into the pack behind the shallow line's back. */
function commitPayloadObjects(store: Store, commitSha: string, into: Set<string>): void {
  const commitObject = getObject(store, commitSha);
  if (commitObject === null || commitObject.type !== 'commit') return;
  into.add(commitSha);
  const treeStack = [parseCommit(commitObject.data).tree];
  while (treeStack.length > 0) {
    const treeSha = treeStack.pop() as string;
    if (into.has(treeSha)) continue;
    const treeObject = getObject(store, treeSha);
    if (treeObject === null || treeObject.type !== 'tree') continue;
    into.add(treeSha);
    for (const entry of parseTree(treeObject.data)) {
      if (entry.mode === '40000') treeStack.push(entry.sha);
      else into.add(entry.sha);
    }
  }
}

/**
 * The commits a client actually holds: the closure of its haves, cut at its shallow boundary.
 * A boundary commit is held, but its parents are not — the whole point of the boundary — so
 * traversal stops there. (Counting the full closure instead would starve every deepen: the
 * parent a deepen must deliver sits below the boundary and would look "already held".)
 */
function heldCommitsOf(store: Store, haves: string[], shallowBoundary: string[]): Set<string> {
  const held = new Set<string>();
  const boundary = new Set(shallowBoundary);
  const queue: string[] = [];
  for (const have of haves) {
    const commit = peelToCommit(store, have);
    if (commit !== null && !held.has(commit)) {
      held.add(commit);
      queue.push(commit);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const sha = queue[head] as string;
    if (boundary.has(sha)) continue;
    const object = getObject(store, sha);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!held.has(parent)) {
        held.add(parent);
        queue.push(parent);
      }
    }
  }
  return held;
}

function planFetch(store: Store, request: FetchRequest): FetchPlan {
  const haveCommits = heldCommitsOf(store, request.haves, request.shallow);
  const haveObjects = new Set<string>();
  for (const sha of haveCommits) commitPayloadObjects(store, sha, haveObjects);

  // The wants' full closure, for ACK purposes — only worth building when the client actually
  // sent haves; a fresh clone (and every clone-workload fetch) has none, and the walk is the
  // whole history long.
  const wantClosure = new Set<string>();
  if (request.haves.length > 0) {
    for (const want of request.wants) {
      for (const sha of commitGenerations(store, want).keys()) wantClosure.add(sha);
    }
  }
  const acks: string[] = [];
  for (const have of request.haves) {
    const commit = peelToCommit(store, have);
    if (commit !== null && wantClosure.has(commit)) acks.push(commit);
  }

  // Breadth-first inclusion from the wants: generation 1 is a wanted commit itself.
  const generations = new Map<string, number>();
  const queue: string[] = [];
  const bonusObjects: string[] = [];
  for (const want of request.wants) {
    const object = getObject(store, want);
    if (object === null) continue;
    if (object.type === 'tag') {
      bonusObjects.push(want);
      const commit = peelToCommit(store, want);
      if (commit !== null && !generations.has(commit)) {
        generations.set(commit, 1);
        queue.push(commit);
      }
    } else if (object.type === 'commit') {
      if (!generations.has(want)) {
        generations.set(want, 1);
        queue.push(want);
      }
    } else {
      bonusObjects.push(want);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const sha = queue[head] as string;
    const gen = generations.get(sha) as number;
    if (request.deepen !== null && gen >= request.deepen) continue;
    const object = getObject(store, sha);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (generations.has(parent) || haveCommits.has(parent)) continue;
      generations.set(parent, gen + 1);
      queue.push(parent);
    }
  }

  const included: string[] = [];
  const shallow: string[] = [];
  for (const [sha, gen] of generations) {
    if (haveCommits.has(sha)) continue;
    if (request.deepen !== null && gen > request.deepen) continue;
    included.push(sha);
    if (request.deepen !== null && gen === request.deepen) shallow.push(sha);
  }
  const unshallow: string[] = [];
  for (const boundary of request.shallow) {
    const gen = generations.get(boundary);
    if (gen !== undefined && (request.deepen === null || gen < request.deepen)) unshallow.push(boundary);
  }

  const objects = new Set<string>();
  for (const sha of bonusObjects) objects.add(sha);
  const includedObjects = new Set<string>();
  for (const sha of included) commitPayloadObjects(store, sha, includedObjects);
  for (const sha of includedObjects) {
    if (!haveObjects.has(sha)) objects.add(sha);
  }
  for (const sha of included) objects.add(sha);
  return { objects: [...objects], shallow, unshallow, acks, nak: acks.length === 0 };
}

// ------------------------------------------------------------------ answer cache

/**
 * Repeated protocol answers, memoized. Git objects are immutable and addressed by
 * their content, so the correct answer to a fixed fetch request cannot change while
 * the process lives: objects that arrive later only add ancestry nobody named, and
 * a commit's parents are fixed by its own hash. A fetch answer is therefore cached
 * once every object the request names is already held (an answer about a missing
 * want could be overtaken by that want's arrival, so those are never stored).
 * Advertisements and ls-refs answers do depend on the ref table, so their keys
 * carry a fingerprint of it, recomputed per request from the handful of refs a
 * repository holds. Both caches are capped; a full cache clears rather than grows.
 */
const ANSWER_CACHE_CAP = 512;
const fetchAnswers = new Map<string, HandlerResult>();
const refAnswers = new Map<string, HandlerResult>();

function rememberAnswer(map: Map<string, HandlerResult>, key: string, result: HandlerResult): HandlerResult {
  if (map.size >= ANSWER_CACHE_CAP) map.clear();
  map.set(key, result);
  return result;
}

/** A string naming the repo's ref state exactly: HEAD's target plus every ref. */
function refsFingerprint(repo: Repo): string {
  let print = headTarget(repo);
  for (const [name, oid] of sortedRefs(repo)) print += `\n${oid} ${name}`;
  return print;
}

/** Everything a fetch answer depends on, as one key. */
function fetchKey(request: FetchRequest, protocol2: boolean): string {
  return [
    protocol2 ? 'v2' : 'v0',
    request.done ? 'done' : 'open',
    `deepen=${request.deepen ?? ''}`,
    `want=${request.wants.join(',')}`,
    `have=${request.haves.join(',')}`,
    `shallow=${request.shallow.join(',')}`,
  ].join('|');
}

/** True when every object the request names is already held, so its answer is final. */
function requestSettled(store: Store, request: FetchRequest): boolean {
  for (const sha of request.wants) if (getObject(store, sha) === null) return false;
  for (const sha of request.haves) if (getObject(store, sha) === null) return false;
  for (const sha of request.shallow) if (getObject(store, sha) === null) return false;
  return true;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, Math.min(at + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

// ------------------------------------------------------------------ upload-pack

function lsRefs(store: Store, repo: Repo, args: string[]): HandlerResult {
  const cacheKey = `ls-refs\n${refsFingerprint(repo)}\n${args.join('\n')}`;
  const cached = refAnswers.get(cacheKey);
  if (cached !== undefined) return cached;
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = getObject(store, oid);
      if (object !== null && object.type === 'tag') line += ` peeled:${peelFully(store, oid)}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return rememberAnswer(refAnswers, cacheKey, { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(lines) });
}

function fetchResult(store: Store, request: FetchRequest, protocol2: boolean): HandlerResult {
  const key = fetchKey(request, protocol2);
  const hit = fetchAnswers.get(key);
  if (hit !== undefined) return hit;
  const result = fetchResultPlanned(store, request, protocol2);
  return requestSettled(store, request) ? rememberAnswer(fetchAnswers, key, result) : result;
}

function fetchResultPlanned(store: Store, request: FetchRequest, protocol2: boolean): HandlerResult {
  const plan = planFetch(store, request);
  const pack = writePack(store, plan.objects);
  const parts: Buffer[] = [];
  if (protocol2) {
    // A request that already said "done" (every HTTP fetch, and every fetch the suite sends)
    // is answered with the data sections only: a stock git client that sent done expects the
    // packfile path, not an acknowledgments section. The acknowledgments section belongs to
    // a negotiation round, where it ends in a delimiter and no packfile follows.
    if (!request.done) {
      // A negotiation round: the acknowledgments section is the whole response, so it ends
      // with a flush, not a delimiter — a delimiter would promise another section, which a
      // stock client refuses when no "ready" line preceded it.
      parts.push(pktLine('acknowledgments\n'));
      if (plan.nak) parts.push(pktLine('NAK\n'));
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(PKT_FLUSH);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
    }
    if (request.done) {
      if (request.deepen !== null || request.shallow.length > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
        for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
        parts.push(PKT_DELIM);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPack(pack));
      parts.push(PKT_FLUSH);
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  if (plan.nak) parts.push(pktLine('NAK\n'));
  for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** POST git-upload-pack: a v2 command (ls-refs / fetch) or a v0 fetch. Throws on malformed input. */
export function uploadPack(store: Store, repo: Repo, body: Buffer): HandlerResult {
  const { pkts } = parsePkts(body, 0);
  const data = pkts.filter((pkt) => pkt.kind === 'data').map((pkt) => (pkt as { payload: Buffer }).payload.toString('utf8'));
  const first = data[0] ?? '';
  if (first.startsWith('command=ls-refs')) {
    // Arguments sit after the delim packet.
    const args: string[] = [];
    let pastDelim = false;
    for (const pkt of pkts) {
      if (pkt.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (!pastDelim || pkt.kind !== 'data') continue;
      args.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
    }
    return lsRefs(store, repo, args);
  }
  if (first.startsWith('command=fetch')) {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false };
    let pastDelim = false;
    for (const pkt of pkts) {
      if (pkt.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (!pastDelim || pkt.kind !== 'data') continue;
      const line = pkt.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.deepen = Number.parseInt(line.slice(7), 10);
      else if (line === 'done') request.done = true;
    }
    return fetchResult(store, request, true);
  }
  if (first.startsWith('want ') || first === '') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false };
    for (const rawLine of data) {
      const line = rawLine.replace(/\n$/, '');
      if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.deepen = Number.parseInt(line.slice(7), 10);
      else if (line === 'done') request.done = true;
    }
    return fetchResult(store, request, false);
  }
  throw new Error('unrecognized upload-pack request');
}

// ------------------------------------------------------------------ receive-pack

interface RefCommand {
  old: string;
  new: string;
  ref: string;
}

/** POST git-receive-pack: apply a push, answering report-status inside the side band. */
export function receivePack(store: Store, repo: Repo, body: Buffer): HandlerResult {
  const { pkts, rest } = splitPktBody(body);
  const commands: RefCommand[] = [];
  let capabilities = '';
  let firstLine = true;
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (firstLine) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      firstLine = false;
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error('malformed receive-pack command');
    commands.push({ old: parts[0] as string, new: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0 && rest.length === 0) throw new Error('empty receive-pack request');

  let unpackError: string | null = null;
  let packObjects = new Map<string, GitObject>();
  if (rest.length > 0) {
    try {
      packObjects = parsePack(rest, (sha) => getObject(store, sha));
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const lookup = (sha: string): GitObject | null => packObjects.get(sha) ?? getObject(store, sha);
  const extra = packObjects.size > 0 ? packObjects : undefined;

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      fail('unpacker error');
      continue;
    }
    if (!command.ref.startsWith('refs/') || command.ref.includes('..') || command.ref.includes(' ')) {
      fail('invalid refname');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.old !== current) {
      fail('stale info');
      continue;
    }
    if (command.new === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (lookup(command.new) === null) {
      fail('invalid object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const newCommit = peelToCommit(store, command.new, extra);
      if (newCommit === null) {
        fail('invalid object');
        continue;
      }
      if (current !== ZERO_OID) {
        const currentCommit = peelToCommit(store, current, extra);
        if (currentCommit !== null && currentCommit !== newCommit && !isAncestor(store, currentCommit, newCommit, extra)) {
          fail('non-fast-forward');
          continue;
        }
      }
    }
    repo.refs.set(command.ref, command.new);
    results.push({ ref: command.ref, ok: true });
  }
  if (unpackError === null) {
    for (const [sha, object] of packObjects) {
      if (!store.objects.has(sha)) store.objects.set(sha, object);
    }
  }

  if (!capabilities.split(' ').includes('report-status')) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: PKT_FLUSH };
  }
  const inner: Buffer[] = [];
  // The report always carries an unpack line, even for a delete-only push that sent no pack:
  // the suite's report parser refuses a report without one.
  inner.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  inner.push(PKT_FLUSH);
  let bodyOut: Buffer;
  if (capabilities.split(' ').includes('side-band-64k')) {
    // Every report pkt travels inside band 1, the report's own terminating flush included;
    // a separate outer flush then ends the sideband stream. A stock git client hangs up if
    // the demuxed report stream is not itself flush-terminated.
    const wrapped = inner.map((pkt) => pktLine(Buffer.concat([Buffer.from([1]), pkt])));
    bodyOut = Buffer.concat([...wrapped, PKT_FLUSH]);
  } else {
    bodyOut = Buffer.concat(inner);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}
