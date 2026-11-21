// A standalone GitHub-compatible git forge: git smart HTTP (upload-pack protocol v2,
// receive-pack v0), the REST v3 API, the GraphQL v4 API and an MCP endpoint, all served
// from one in-memory store by one process. Node standard library only.
//
// The store is one process's memory: repositories created through the API live beside the
// git objects pushed to them, and every surface (REST, GraphQL, MCP, git) reads and writes
// the same objects, so an issue opened over MCP is the issue REST reads back.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// The viewer: the one login the trial's bearer token names. A repository belongs to this
// login; the same name under any other owner is a 404, never a 403.

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'makefun-forge/1.0';
const ZERO_OID = '0'.repeat(40);
const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------------------------
// A logical clock. Trial replays must leave identical state, so no wall clock reaches an
// answer: timestamps start at MAKEFUN_TRIAL_NOW (or a fixed epoch) and advance one second
// per stamped event, in request order alone.

const CLOCK_BASE = ((): number => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_735_689_600;
})();
let clockTick = 0;
function nowSec(): number {
  clockTick += 1;
  return CLOCK_BASE + clockTick;
}
function nowIso(): string {
  return new Date(nowSec() * 1000).toISOString();
}
function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** GitHub wraps base64 content at 60 columns; decoders on the other side ignore the breaks. */
function b64Wrap(data: Buffer): string {
  const raw = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 60) lines.push(raw.slice(i, i + 60));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function b64decodeText(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Relay-style global id: base64url of "<Type>:<key>", stable across reads of one run. */
function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------------------------------------
// Git objects

type GitType = 'blob' | 'tree' | 'commit' | 'tag';

interface GitObject {
  type: GitType;
  data: Buffer;
}

const TYPE_TO_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: GitType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([header, data]));
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, directories as if their name carried a trailing '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(fields: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** "Name <email> epoch +0000" from a stored ident line. */
function identParts(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) /.exec(ident);
  if (match === null) return { name: ident, email: '', date: isoOf(CLOCK_BASE) };
  return { name: match[1], email: match[2], date: isoOf(Number(match[3])) };
}

// ---------------------------------------------------------------------------------------------
// Delta compression (packfiles in and out speak it; this forge only ever sends full objects,
// but a pushed pack may carry deltas and they must resolve).

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== resultSize || result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/** Inflate one zlib stream starting at `offset`; returns the data and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine || result.engine.bytesWritten <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

// ---------------------------------------------------------------------------------------------
// The store

interface Label {
  name: string;
  color: string;
  description: string | null;
}

interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

type IssueOrPull = Issue | Pull;

interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  entries: Map<number, IssueOrPull>;
  nextNumber: number;
  gens: Map<string, number>;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function createRepoRecord(name: string, priv: boolean, description: string | null): Repo {
  const stamp = nowIso();
  const repo: Repo = {
    id: nextRepoId,
    owner: VIEWER_LOGIN,
    name,
    private: priv,
    description,
    defaultBranch: 'main',
    createdAt: stamp,
    updatedAt: stamp,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    entries: new Map(),
    nextNumber: 1,
    gens: new Map(),
  };
  nextRepoId += 1;
  repos.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

/** The repository the token's owner holds under `name`, or null (any other owner is a 404). */
function ownedRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Object graph walks on one repository

function storeObject(repo: Repo, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getCommit(repo: Repo, oid: string): CommitView | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Follow tag objects to the commit they name; null when the chain does not end at a commit. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Generation of a commit (longest path to a root), memoised: commits are immutable. */
function commitGen(repo: Repo, oid: string): number {
  const cached = repo.gens.get(oid);
  if (cached !== undefined) return cached;
  const commit = getCommit(repo, oid);
  if (commit === null) return 0;
  let gen = 0;
  for (const parent of commit.parents) gen = Math.max(gen, commitGen(repo, parent) + 1);
  repo.gens.set(oid, gen);
  return gen;
}

/** Every ancestor of `tip`, tip included (commits only). */
function ancestorSet(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    seen.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  return ancestorSet(repo, tip).has(ancestor);
}

/** The deepest common ancestor of two commits, or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = ancestorSet(repo, a);
  let best: string | null = null;
  let bestGen = -1;
  for (const oid of ancestorSet(repo, b)) {
    if (!ancestorsA.has(oid)) continue;
    const gen = commitGen(repo, oid);
    if (gen > bestGen) {
      bestGen = gen;
      best = oid;
    }
  }
  return best;
}

/** Add a tree and everything under it to `out`. */
function collectTree(repo: Repo, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  out.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') collectTree(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/**
 * The full object closure of `tips`: commits with their trees and ancestry, trees recursively,
 * tags through to their targets. Commits in `stopAt` are included but their parents are not
 * walked (a shallow boundary the client already holds).
 */
function closure(repo: Repo, tips: Iterable<string>, stopAt?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      collectTree(repo, commit.tree, out);
      if (stopAt === undefined || !stopAt.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      collectTree(repo, oid, out);
    }
  }
  return out;
}

/** Flatten a tree into path -> {oid, mode}; the empty map for a missing tree. */
function flattenTree(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild a tree hierarchy from a flattened path map; returns the root tree's oid. */
function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (!node.dirs.has(segment)) node.dirs.set(segment, make());
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit, or null. */
function commitTree(repo: Repo, commitOid: string): string | null {
  const commit = getCommit(repo, commitOid);
  return commit === null ? null : commit.tree;
}

/** Resolve a ref name, branch name or commit oid to a commit oid. */
function resolveCommit(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) {
    const target = repo.refs.get(ref) as string;
    return peelToCommit(repo, target);
  }
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return peelToCommit(repo, repo.refs.get(branchRef) as string);
  const tagRef = `refs/tags/${ref}`;
  if (repo.refs.has(tagRef)) return peelToCommit(repo, repo.refs.get(tagRef) as string);
  if (isOid(ref) && repo.objects.has(ref)) return peelToCommit(repo, ref);
  return null;
}

/** The forge's own ident for the commits it authors (contents API, merges). */
function forgeIdent(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${nowSec()} +0000`;
}

// ---------------------------------------------------------------------------------------------
// Packfiles

/** A pack of full objects only: no deltas, nothing thin — every base a reader needs is inside. */
function buildPack(objects: { type: GitType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const size = object.data.length;
    const code = TYPE_TO_CODE[object.type];
    const first = size >= 16 ? (code << 4) | (size & 0x0f) | 0x80 : (code << 4) | size;
    const varint: number[] = [first];
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) byte |= 0x80;
      varint.push(byte);
    }
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  type: GitType;
  oid: string;
  data: Buffer;
}

/** Read a pack (full objects and OFS/REF deltas alike) into fully resolved objects. */
function readPack(pack: Buffer): PackEntry[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('packfile checksum mismatch');
  const byOffset = new Map<number, { type: GitType; data: Buffer }>();
  const byOid = new Map<string, { type: GitType; data: Buffer }>();
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === 6) {
      // OFS_DELTA: a negative offset back to the base entry
      let back = pack[offset];
      offset += 1;
      let backOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        backOffset = ((backOffset + 1) << 7) | (back & 0x7f);
      }
      const baseOffset = entryOffset - backOffset;
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error('ofs-delta base missing');
      const resolved = { type: base.type, data: applyDelta(base.data, data) };
      byOffset.set(entryOffset, resolved);
      const oid = hashObject(resolved.type, resolved.data);
      byOid.set(oid, resolved);
      entries.push({ type: resolved.type, oid, data: resolved.data });
    } else if (code === 7) {
      // REF_DELTA: the base named by oid, inside this pack or already in the repo
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      entries.push({ type: 'blob', oid: `refdelta:${baseOid}:${entryOffset}`, data });
      byOffset.set(entryOffset, { type: 'blob', data });
      // resolved in the second pass below
      (entries[entries.length - 1] as unknown as { pendingBase: string }).pendingBase = baseOid;
    } else {
      const type = CODE_TO_TYPE[code];
      if (type === undefined) throw new Error(`unknown pack object type ${code}`);
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const resolved = { type, data };
      byOffset.set(entryOffset, resolved);
      const oid = hashObject(type, data);
      byOid.set(oid, resolved);
      entries.push({ type, oid, data });
    }
  }
  // Second pass: resolve REF_DELTA entries now that every full object is known.
  for (const entry of entries) {
    const pending = (entry as unknown as { pendingBase?: string }).pendingBase;
    if (pending === undefined) continue;
    const base = byOid.get(pending);
    if (base === undefined) throw new Error('ref-delta base missing');
    entry.type = base.type;
    entry.data = applyDelta(base.data, entry.data);
    entry.oid = hashObject(entry.type, entry.data);
    delete (entry as unknown as { pendingBase?: string }).pendingBase;
  }
  return entries;
}

/**
 * Built packs are a pure function of the object set, and fetch workloads repeat identical
 * requests (fifty clones of one tip): cache the bytes. Bounded, oldest-first eviction.
 */
const packCache = new Map<string, Buffer>();

function cachedPack(repo: Repo, oids: ReadonlySet<string>): Buffer {
  const key = `${repo.id}:${[...oids].sort().join(',')}`;
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = buildPack(packObjectsFor(repo, oids));
  if (packCache.size >= 32) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

/** Collect the pack entries a fetch sends, commits first so readers see parents early. */
function packObjectsFor(repo: Repo, oids: ReadonlySet<string>): { type: GitType; data: Buffer }[] {
  const order: Record<GitType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const list = [...oids]
    .map((oid) => ({ oid, object: repo.objects.get(oid) }))
    .filter((entry): entry is { oid: string; object: GitObject } => entry.object !== undefined)
    .sort((a, b) => order[a.object.type] - order[b.object.type]);
  return list.map((entry) => ({ type: entry.object.type, data: entry.object.data }));
}

// ---------------------------------------------------------------------------------------------
// Domain operations shared by REST, GraphQL and MCP

interface ContentsResult {
  status: number;
  contentSha: string;
  commitSha: string;
  created: boolean;
}

/** Write (or, with content === null, delete) one file as a real commit on a branch. */
function applyContentsChange(
  repo: Repo,
  path: string,
  content: Buffer | null,
  branch: string,
  message: string,
  expectedSha: string | undefined,
): ContentsResult | { status: number; error: string } {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const tipCommit = tip !== undefined ? peelToCommit(repo, tip) : null;
  const baseTree = tipCommit !== null ? commitTree(repo, tipCommit) : null;
  const flat = flattenTree(repo, baseTree);
  const existing = flat.get(path);
  if (content === null) {
    if (existing === undefined) return { status: 404, error: 'Not Found' };
    if (expectedSha !== undefined && expectedSha !== existing.oid) return { status: 409, error: 'Conflict' };
    flat.delete(path);
  } else {
    if (existing !== undefined && expectedSha !== undefined && expectedSha !== existing.oid) {
      return { status: 409, error: 'Conflict' };
    }
    const blobOid = storeObject(repo, 'blob', content);
    flat.set(path, { oid: blobOid, mode: '100644' });
  }
  const newTree = buildTreeFromFlat(repo, flat);
  const ident = forgeIdent();
  const commitData = buildCommit({
    tree: newTree,
    parents: tipCommit !== null ? [tipCommit] : [],
    author: ident,
    committer: ident,
    message,
  });
  const commitSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  repo.updatedAt = nowIso();
  return {
    status: content !== null && existing === undefined ? 201 : 200,
    contentSha: content !== null ? (flat.get(path) as { oid: string }).oid : '',
    commitSha,
    created: existing === undefined,
  };
}

/** Line counts of a diff between two blob contents (LCS-based, exact for the sizes here). */
function diffCounts(before: string | null, after: string | null): { additions: number; deletions: number } {
  const linesOf = (text: string | null): string[] => {
    if (text === null || text === '') return [];
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const a = linesOf(before);
  const b = linesOf(after);
  // LCS length via dynamic programming over the shorter axis.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array<number>(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    const cur = new Array<number>(short.length + 1).fill(0);
    for (let j = 1; j <= short.length; j += 1) {
      cur[j] = long[i - 1] === short[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    prev = cur;
  }
  const lcs = prev[short.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two commits (merge base tree on the left when given). */
function diffCommits(repo: Repo, fromCommit: string | null, toCommit: string | null): FileChange[] {
  const fromFlat = flattenTree(repo, fromCommit !== null ? commitTree(repo, fromCommit) : null);
  const toFlat = flattenTree(repo, toCommit !== null ? commitTree(repo, toCommit) : null);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = fromFlat.get(path);
    const after = toFlat.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid && before.mode === after.mode) continue;
    const readText = (entry: { oid: string } | undefined): string | null => {
      if (entry === undefined) return null;
      const object = repo.objects.get(entry.oid);
      return object === undefined ? null : object.data.toString('utf8');
    };
    const counts = diffCounts(readText(before), readText(after));
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

/** Three-way tree merge: returns the merged flat tree, or the list of conflicted paths. */
function mergeTrees(
  repo: Repo,
  baseFlat: ReadonlyMap<string, { oid: string; mode: string }>,
  oursFlat: ReadonlyMap<string, { oid: string; mode: string }>,
  theirsFlat: ReadonlyMap<string, { oid: string; mode: string }>,
): { merged: Map<string, { oid: string; mode: string }> } | { conflicts: string[] } {
  const same = (a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const ours = oursFlat.get(path);
    const theirs = theirsFlat.get(path);
    if (same(ours, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (same(base, ours)) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (same(base, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      conflicts.push(path);
    }
  }
  return conflicts.length ? { conflicts } : { merged };
}

type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'not-found' | 'conflict' | 'already-merged' | 'invalid' };

/** Merge a pull request (squash or merge commit) exactly as GitHub would record it. */
function mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge' | 'rebase'): MergeOutcome {
  if (pull.merged) return { ok: false, reason: 'already-merged' };
  const baseTip = resolveCommit(repo, pull.baseRef);
  const headTip = resolveCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'invalid' };
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = flattenTree(repo, base !== null ? commitTree(repo, base) : null);
  const oursFlat = flattenTree(repo, commitTree(repo, baseTip));
  const theirsFlat = flattenTree(repo, commitTree(repo, headTip));
  const result = mergeTrees(repo, baseFlat, oursFlat, theirsFlat);
  if ('conflicts' in result) return { ok: false, reason: 'conflict' };
  const newTree = buildTreeFromFlat(repo, result.merged);
  const ident = forgeIdent();
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    parents = [baseTip, headTip];
  } else {
    message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}\n`;
    parents = [baseTip];
  }
  const commitData = buildCommit({ tree: newTree, parents, author: ident, committer: ident, message });
  const sha = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  repo.updatedAt = pull.mergedAt;
  return { ok: true, sha };
}

/** Whether a pull would merge cleanly right now. */
function pullMergeable(repo: Repo, pull: Pull): boolean | null {
  if (pull.merged) return true;
  const baseTip = resolveCommit(repo, pull.baseRef);
  const headTip = resolveCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const base = mergeBase(repo, baseTip, headTip);
  const result = mergeTrees(
    repo,
    flattenTree(repo, base !== null ? commitTree(repo, base) : null),
    flattenTree(repo, commitTree(repo, baseTip)),
    flattenTree(repo, commitTree(repo, headTip)),
  );
  return 'merged' in result;
}

// ---------------------------------------------------------------------------------------------
// JSON shapes (REST)

function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', String(VIEWER_ID)),
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: repos.size,
    created_at: isoOf(CLOCK_BASE),
    updated_at: isoOf(CLOCK_BASE),
  };
}

function repoJson(repo: Repo, base: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: fullName,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: globalId('User', String(VIEWER_ID)), type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${fullName}`,
    html_url: `${base}/${fullName}`,
    clone_url: `${base}/${fullName}.git`,
    git_url: `git://${base.replace(/^https?:\/\//, '')}/${fullName}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.entries.values()].filter((entry) => entry.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: Math.abs([...label.name].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7)), name: label.name, color: label.color, description: label.description, default: false };
}

function commentJson(repo: Repo, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: '',
    html_url: '',
    repo_id: repo.id,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: null };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: '',
    url: '',
    repository_url: '',
  };
}

function pullJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const headTip = resolveCommit(repo, pull.headRef);
  const baseTip = resolveCommit(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    mergeable_state: pull.merged ? 'clean' : 'unknown',
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip ?? ZERO_OID,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo, base),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip ?? ZERO_OID,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo, base),
    },
    html_url: '',
    url: '',
    _links: {},
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${CLOCK_BASE.toString(36)}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
    'X-GitHub-Api-Version': '2022-11-28',
    ...headers,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'X-GitHub-Request-Id': nextRequestId(), 'Content-Length': '0' });
  res.end();
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function validationFailed(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message, errors: [{ resource: 'Forge', field: '', code: 'custom', message }] });
}

interface Ctx {
  method: string;
  url: URL;
  segments: string[];
  body: Record<string, unknown> | null;
  base: string;
}

function bodyString(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const commit = getCommit(repo, sha);
  if (commit === null) return { sha };
  const author = identParts(commit.author);
  const committer = identParts(commit.committer);
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    url: '',
    html_url: '',
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------------------------------------
// REST v3

function restRoot(ctx: Ctx, res: ServerResponse): void {
  sendJson(
    res,
    200,
    {
      current_user_url: `${ctx.base}/api/v3/user`,
      current_user_repositories_url: `${ctx.base}/api/v3/user/repos`,
      repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
      issue_url: `${ctx.base}/api/v3/repos/{owner}/{repo}/issues/{number}`,
      emojis_url: `${ctx.base}/api/v3/emojis`,
      rate_limit_url: `${ctx.base}/api/v3/rate_limit`,
    },
    { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo, read:org' },
  );
}

function restCreateRepo(ctx: Ctx, res: ServerResponse): void {
  const name = bodyString(ctx.body, 'name');
  if (name === undefined || name === '' || /[/\s]/.test(name)) {
    validationFailed(res, 'name is required and must be a valid repository name');
    return;
  }
  if (repos.has(repoKey(VIEWER_LOGIN, name))) {
    validationFailed(res, 'name already exists on this account');
    return;
  }
  const priv = ctx.body?.private === true;
  const description = bodyString(ctx.body, 'description') ?? null;
  const repo = createRepoRecord(name, priv, description);
  if (ctx.body?.auto_init === true) {
    const blob = storeObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const tree = buildTreeFromFlat(repo, new Map([['README.md', { oid: blob, mode: '100644' }]]));
    const ident = forgeIdent();
    const commit = buildCommit({ tree, parents: [], author: ident, committer: ident, message: 'Initial commit' });
    repo.refs.set('refs/heads/main', storeObject(repo, 'commit', commit));
  }
  sendJson(res, 201, repoJson(repo, ctx.base));
}

function restListUserRepos(ctx: Ctx, res: ServerResponse): void {
  const perPage = Math.max(1, Math.min(100, Number(ctx.url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.url.searchParams.get('page') ?? '1') || 1);
  const all = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const next = `${ctx.base}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(all.length / perPage);
    const last = `${ctx.base}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
    headers.Link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  sendJson(res, 200, slice.map((repo) => repoJson(repo, ctx.base)), headers);
}

function restRepo(ctx: Ctx, res: ServerResponse, repo: Repo): void {
  if (ctx.method === 'GET') {
    sendJson(res, 200, repoJson(repo, ctx.base));
    return;
  }
  if (ctx.method === 'PATCH') {
    const description = bodyString(ctx.body, 'description');
    if (description !== undefined) repo.description = description;
    if (typeof ctx.body?.private === 'boolean') repo.private = ctx.body.private;
    const newName = bodyString(ctx.body, 'name');
    if (newName !== undefined && newName !== '' && newName !== repo.name) {
      repos.delete(repoKey(repo.owner, repo.name));
      repo.name = newName;
      repos.set(repoKey(repo.owner, repo.name), repo);
    }
    repo.updatedAt = nowIso();
    sendJson(res, 200, repoJson(repo, ctx.base));
    return;
  }
  if (ctx.method === 'DELETE') {
    repos.delete(repoKey(repo.owner, repo.name));
    sendEmpty(res, 204);
    return;
  }
  notFound(res);
}

function restGitRefObject(repo: Repo, refName: string): Record<string, unknown> {
  const oid = repo.refs.get(refName) as string;
  const object = repo.objects.get(oid);
  return {
    ref: refName,
    node_id: globalId('Ref', `${repo.id}:${refName}`),
    url: '',
    object: { type: object?.type ?? 'commit', sha: oid, url: '' },
  };
}

function restBranches(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method !== 'GET') return notFound(res);
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: oid, url: '' },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
    return;
  }
  const name = rest.join('/');
  const oid = repo.refs.get(`refs/heads/${name}`);
  if (oid === undefined) return notFound(res);
  if (ctx.method !== 'GET') return notFound(res);
  sendJson(res, 200, { name, commit: { sha: oid, url: '' }, protected: false });
}

function restGitRefs(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string[]): void {
  // POST /git/refs creates; GET /git/refs/<ref...> reads (the ref path arrives whole).
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const ref = bodyString(ctx.body, 'ref');
      const sha = bodyString(ctx.body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !repo.objects.has(sha)) {
        validationFailed(res, 'ref and a sha naming an existing object are required');
        return;
      }
      if (repo.refs.has(ref)) {
        validationFailed(res, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      repo.updatedAt = nowIso();
      sendJson(res, 201, restGitRefObject(repo, ref));
      return;
    }
    if (ctx.method === 'GET') {
      sendJson(res, 200, [...repo.refs.keys()].map((ref) => restGitRefObject(repo, ref)));
      return;
    }
    return notFound(res);
  }
  let refName = rest.join('/');
  if (!refName.startsWith('refs/')) refName = `refs/${refName}`;
  if (!repo.refs.has(refName)) return notFound(res);
  if (ctx.method === 'GET') {
    sendJson(res, 200, restGitRefObject(repo, refName));
    return;
  }
  if (ctx.method === 'DELETE') {
    repo.refs.delete(refName);
    sendEmpty(res, 204);
    return;
  }
  notFound(res);
}

function restCommits(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (rest.length > 0) {
    const sha = rest[0];
    if (!isOid(sha) || getCommit(repo, sha) === null) return notFound(res);
    sendJson(res, 200, commitJson(repo, sha));
    return;
  }
  if (ctx.method !== 'GET') return notFound(res);
  const refParam = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = resolveCommit(repo, refParam);
  if (tip === null) {
    sendJson(res, 200, []);
    return;
  }
  const perPage = Math.max(1, Math.min(100, Number(ctx.url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.url.searchParams.get('page') ?? '1') || 1);
  const history = [...ancestorSet(repo, tip)].sort((a, b) => commitGen(repo, b) - commitGen(repo, a) || (a < b ? -1 : 1));
  sendJson(res, 200, history.slice((page - 1) * perPage, page * perPage).map((sha) => commitJson(repo, sha)));
}

/** The tree entry at `path` below `treeOid`, or null. */
function lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function contentsEntryJson(repo: Repo, entry: TreeEntry, fullPath: string): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const object = repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir || object === undefined ? 0 : object.data.length,
    name: entry.name,
    path: fullPath,
    sha: entry.oid,
    url: '',
    git_url: '',
    html_url: '',
    download_url: '',
    _links: { self: '', git: '', html: '' },
  };
}

function restContents(ctx: Ctx, res: ServerResponse, repo: Repo, path: string): void {
  if (ctx.method === 'PUT') {
    const message = bodyString(ctx.body, 'message');
    const content = bodyString(ctx.body, 'content');
    if (message === undefined || content === undefined || path === '') {
      validationFailed(res, 'message and content are required');
      return;
    }
    const branch = bodyString(ctx.body, 'branch') ?? repo.defaultBranch;
    const result = applyContentsChange(repo, path, b64decodeText(content), branch, message, bodyString(ctx.body, 'sha'));
    if ('error' in result) {
      if (result.status === 409) sendJson(res, 409, { message: 'Conflict: the supplied sha does not match the current file' });
      else notFound(res);
      return;
    }
    const blob = repo.objects.get(result.contentSha);
    sendJson(res, result.status, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: blob?.data.length ?? 0,
        name: path.split('/').pop() ?? path,
        path,
        sha: result.contentSha,
        url: '',
        git_url: '',
        html_url: '',
        download_url: '',
        _links: { self: '', git: '', html: '' },
      },
      commit: commitJson(repo, result.commitSha),
    });
    return;
  }
  if (ctx.method === 'DELETE') {
    const message = bodyString(ctx.body, 'message');
    const sha = bodyString(ctx.body, 'sha');
    if (message === undefined || sha === undefined || path === '') {
      validationFailed(res, 'message and sha are required');
      return;
    }
    const branch = bodyString(ctx.body, 'branch') ?? repo.defaultBranch;
    const result = applyContentsChange(repo, path, null, branch, message, sha);
    if ('error' in result) {
      if (result.status === 409) sendJson(res, 409, { message: 'Conflict: the supplied sha does not match the current file' });
      else notFound(res);
      return;
    }
    sendJson(res, 200, { content: null, commit: commitJson(repo, result.commitSha) });
    return;
  }
  if (ctx.method !== 'GET') return notFound(res);
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const commitOid = resolveCommit(repo, ref);
  if (commitOid === null) return notFound(res);
  const treeOid = commitTree(repo, commitOid);
  if (treeOid === null) return notFound(res);
  if (path === '') {
    const entries = parseTree((repo.objects.get(treeOid) as GitObject).data);
    sendJson(res, 200, entries.map((entry) => contentsEntryJson(repo, entry, entry.name)));
    return;
  }
  const found = lookupPath(repo, treeOid, path);
  if (found === null) return notFound(res);
  if (found.mode === '40000') {
    const dirObject = repo.objects.get(found.oid);
    if (dirObject === undefined) return notFound(res);
    const entries = parseTree(dirObject.data);
    sendJson(res, 200, entries.map((entry) => contentsEntryJson(repo, entry, `${path}/${entry.name}`)));
    return;
  }
  const blob = repo.objects.get(found.oid);
  if (blob === undefined) return notFound(res);
  sendJson(res, 200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: b64Wrap(blob.data),
    sha: found.oid,
    url: '',
    git_url: '',
    html_url: '',
    download_url: '',
    _links: { self: '', git: '', html: '' },
  });
}

function restLabels(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    if (ctx.method === 'POST') {
      const name = bodyString(ctx.body, 'name');
      if (name === undefined || name === '') {
        validationFailed(res, 'name is required');
        return;
      }
      if (repo.labels.has(name)) {
        validationFailed(res, 'name has already been taken');
        return;
      }
      const label: Label = {
        name,
        color: (bodyString(ctx.body, 'color') ?? 'ededed').replace(/^#/, ''),
        description: bodyString(ctx.body, 'description') ?? null,
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    return notFound(res);
  }
  const label = repo.labels.get(rest.join('/'));
  if (label === undefined) return notFound(res);
  if (ctx.method === 'GET') sendJson(res, 200, labelJson(label));
  else notFound(res);
}

function labelNamesFrom(body: Record<string, unknown> | null): string[] | null {
  const raw = body?.labels;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

function restIssues(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const title = bodyString(ctx.body, 'title');
      if (title === undefined || title === '') {
        validationFailed(res, 'title is required');
        return;
      }
      const names = labelNamesFrom(ctx.body) ?? [];
      for (const name of names) {
        if (!repo.labels.has(name)) {
          validationFailed(res, `label "${name}" does not exist`);
          return;
        }
      }
      const stamp = nowIso();
      const issue: Issue = {
        kind: 'issue',
        id: nextIssueId,
        number: repo.nextNumber,
        title,
        body: bodyString(ctx.body, 'body') ?? '',
        state: 'open',
        labels: names,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.entries.set(issue.number, issue);
      repo.updatedAt = stamp;
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      const labelFilter = ctx.url.searchParams.get('labels');
      let issues = [...repo.entries.values()].filter((entry): entry is Issue => entry.kind === 'issue');
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (labelFilter !== null && labelFilter !== '') {
        const wanted = labelFilter.split(',');
        issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
      }
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(res, 200, issues.map((issue) => issueJson(repo, issue)));
      return;
    }
    return notFound(res);
  }
  const number = Number(rest[0]);
  const entry = Number.isInteger(number) ? repo.entries.get(number) : undefined;
  if (rest.length === 2 && rest[1] === 'comments') {
    if (entry === undefined) return notFound(res);
    if (ctx.method === 'GET') {
      sendJson(res, 200, entry.comments.map((comment) => commentJson(repo, comment)));
      return;
    }
    if (ctx.method === 'POST') {
      const body = bodyString(ctx.body, 'body');
      if (body === undefined) {
        validationFailed(res, 'body is required');
        return;
      }
      const stamp = nowIso();
      const comment: IssueComment = { id: nextCommentId, body, createdAt: stamp, updatedAt: stamp };
      nextCommentId += 1;
      entry.comments.push(comment);
      entry.updatedAt = stamp;
      sendJson(res, 201, commentJson(repo, comment));
      return;
    }
    return notFound(res);
  }
  if (rest.length !== 1 || entry === undefined || entry.kind !== 'issue') return notFound(res);
  if (ctx.method === 'GET') {
    sendJson(res, 200, issueJson(repo, entry));
    return;
  }
  if (ctx.method === 'PATCH') {
    const title = bodyString(ctx.body, 'title');
    if (title !== undefined) entry.title = title;
    const body = bodyString(ctx.body, 'body');
    if (body !== undefined) entry.body = body;
    const state = bodyString(ctx.body, 'state');
    if (state === 'open' || state === 'closed') entry.state = state;
    const names = labelNamesFrom(ctx.body);
    if (names !== null) {
      for (const name of names) {
        if (!repo.labels.has(name)) {
          validationFailed(res, `label "${name}" does not exist`);
          return;
        }
      }
      entry.labels = names;
    }
    entry.updatedAt = nowIso();
    sendJson(res, 200, issueJson(repo, entry));
    return;
  }
  notFound(res);
}

function restPulls(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const title = bodyString(ctx.body, 'title');
      const headRaw = bodyString(ctx.body, 'head');
      const baseRaw = bodyString(ctx.body, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        validationFailed(res, 'title, head and base are required');
        return;
      }
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (resolveCommit(repo, head) === null) {
        validationFailed(res, `head branch "${head}" does not exist`);
        return;
      }
      if (resolveCommit(repo, base) === null) {
        validationFailed(res, `base branch "${base}" does not exist`);
        return;
      }
      const duplicate = [...repo.entries.values()].some(
        (entry) => entry.kind === 'pull' && entry.state === 'open' && entry.headRef === head && entry.baseRef === base,
      );
      if (duplicate) {
        validationFailed(res, `A pull request already exists for ${repo.owner}:${head}.`);
        return;
      }
      const stamp = nowIso();
      const pull: Pull = {
        kind: 'pull',
        id: nextIssueId,
        number: repo.nextNumber,
        title,
        body: bodyString(ctx.body, 'body') ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.entries.set(pull.number, pull);
      repo.updatedAt = stamp;
      sendJson(res, 201, pullJson(repo, pull, ctx.base));
      return;
    }
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let pulls = [...repo.entries.values()].filter((entry): entry is Pull => entry.kind === 'pull');
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(res, 200, pulls.map((pull) => pullJson(repo, pull, ctx.base)));
      return;
    }
    return notFound(res);
  }
  const number = Number(rest[0]);
  const entry = Number.isInteger(number) ? repo.entries.get(number) : undefined;
  if (entry === undefined || entry.kind !== 'pull') return notFound(res);
  if (rest.length === 2 && rest[1] === 'files') {
    if (ctx.method !== 'GET') return notFound(res);
    const headTip = resolveCommit(repo, entry.headRef);
    const baseTip = resolveCommit(repo, entry.baseRef);
    const base = headTip !== null && baseTip !== null ? mergeBase(repo, baseTip, headTip) : null;
    const changes = diffCommits(repo, base, headTip);
    sendJson(
      res,
      200,
      changes.map((change) => ({
        sha: '',
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      })),
    );
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (ctx.method !== 'PUT' && ctx.method !== 'POST') return notFound(res);
    const methodRaw = bodyString(ctx.body, 'merge_method') ?? 'merge';
    const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
    const outcome = mergePull(repo, entry, method);
    if (!outcome.ok) {
      if (outcome.reason === 'not-found') return notFound(res);
      sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  if (rest.length !== 1) return notFound(res);
  if (ctx.method === 'GET') {
    sendJson(res, 200, pullJson(repo, entry, ctx.base));
    return;
  }
  if (ctx.method === 'PATCH') {
    const title = bodyString(ctx.body, 'title');
    if (title !== undefined) entry.title = title;
    const body = bodyString(ctx.body, 'body');
    if (body !== undefined) entry.body = body;
    const state = bodyString(ctx.body, 'state');
    if (state === 'open' || state === 'closed') entry.state = state;
    entry.updatedAt = nowIso();
    sendJson(res, 200, pullJson(repo, entry, ctx.base));
    return;
  }
  notFound(res);
}

function handleRest(ctx: Ctx, res: ServerResponse): void {
  const seg = ctx.segments;
  if (seg.length === 0) {
    if (ctx.method === 'GET') return restRoot(ctx, res);
    return notFound(res);
  }
  if (seg[0] === 'meta' && seg.length === 1 && ctx.method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0',
      hooks: [],
      git: {},
      api: {},
      web: {},
      pages: {},
      importer: {},
      actions: {},
      dependabot: {},
      code_scanning: {},
      packages: [],
    });
    return;
  }
  if (seg[0] === 'user' && seg.length === 1 && ctx.method === 'GET') {
    sendJson(res, 200, viewerJson());
    return;
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (ctx.method === 'POST') return restCreateRepo(ctx, res);
    if (ctx.method === 'GET') return restListUserRepos(ctx, res);
    return notFound(res);
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = ownedRepo(seg[1], seg[2]);
    if (repo === null) return notFound(res);
    const rest = seg.slice(3);
    if (rest.length === 0) return restRepo(ctx, res, repo);
    if (rest[0] === 'branches') return restBranches(ctx, res, repo, rest.slice(1));
    if (rest[0] === 'git' && rest[1] === 'refs') return restGitRefs(ctx, res, repo, rest.slice(2));
    if (rest[0] === 'commits') return restCommits(ctx, res, repo, rest.slice(1));
    if (rest[0] === 'contents') return restContents(ctx, res, repo, rest.slice(1).join('/'));
    if (rest[0] === 'labels') return restLabels(ctx, res, repo, rest.slice(1));
    if (rest[0] === 'issues') return restIssues(ctx, res, repo, rest.slice(1));
    if (rest[0] === 'pulls') return restPulls(ctx, res, repo, rest.slice(1));
    return notFound(res);
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// pkt-lines and the git smart HTTP protocol

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Pkt =
  | { kind: 'data'; payload: Buffer; next: number }
  | { kind: 'flush' | 'delim' | 'end'; next: number };

function parsePktAt(buffer: Buffer, offset: number): Pkt {
  if (offset + 4 > buffer.length) return { kind: 'end', next: offset };
  const hex = buffer.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('malformed pkt-line');
  const length = parseInt(hex, 16);
  if (length === 0) return { kind: 'flush', next: offset + 4 };
  if (length === 1) return { kind: 'delim', next: offset + 4 };
  if (length === 2) return { kind: 'flush', next: offset + 4 };
  if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
  return { kind: 'data', payload: buffer.subarray(offset + 4, offset + length), next: offset + length };
}

/** Read pkt-lines until a flush; returns the payloads and the offset just past the flush. */
function readPktSection(buffer: Buffer, offset: number): { lines: Buffer[]; next: number } {
  const lines: Buffer[] = [];
  let cursor = offset;
  for (;;) {
    const pkt = parsePktAt(buffer, cursor);
    cursor = pkt.next;
    if (pkt.kind !== 'data') return { lines, next: cursor };
    lines.push(pkt.payload);
  }
}

function sidebandFrame(data: Buffer, band: number): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65_514;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

function lineText(payload: Buffer): string {
  const text = payload.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

interface RefAdvert {
  name: string;
  oid: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

/** The refs a repository advertises, HEAD first, the rest in name order. */
function advertisedRefs(repo: Repo, peel: boolean): RefAdvert[] {
  const out: RefAdvert[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) out.push({ name: 'HEAD', oid: headOid, symrefTarget: headTarget });
  else out.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: headTarget, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const advert: RefAdvert = { name, oid };
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const target = peelToCommit(repo, oid);
        if (target !== null) advert.peeled = target;
      }
    }
    out.push(advert);
  }
  return out;
}

function gitInfoRefs(repo: Repo, service: string, protocol: string | null, res: ServerResponse): void {
  if (service === 'git-upload-pack' && protocol !== null && /(^|:)version=2/.test(protocol)) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('unknown service');
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;
  const adverts = advertisedRefs(repo, true).filter((advert) => !advert.unborn);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (adverts.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    adverts.forEach((advert, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${advert.oid} ${advert.name}${suffix}`));
      if (advert.peeled !== undefined) parts.push(pktLine(`${advert.peeled} ${advert.name}^{}`));
    });
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, {
    'Content-Type': `application/x-${service}-advertisement`,
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function gitLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  let adverts = advertisedRefs(repo, peel);
  if (prefixes.length) adverts = adverts.filter((advert) => prefixes.some((prefix) => advert.name.startsWith(prefix)));
  const parts: Buffer[] = [];
  for (const advert of adverts) {
    let line = `${advert.oid} ${advert.name}`;
    if (advert.symrefTarget !== undefined && symrefs) line += ` symref-target:${advert.symrefTarget}`;
    if (advert.peeled !== undefined) line += ` peeled:${advert.peeled}`;
    if (advert.unborn) line += ' unborn';
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Content-Length': String(body.length) });
  res.end(body);
}

function gitFetch(repo: Repo, args: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5, 45));
    else if (arg.startsWith('shallow ')) shallowArgs.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'done') done = true;
  }
  const shallowSet = new Set(shallowArgs);
  // What the client already holds: full closure of the haves, stopping at its shallow line.
  const haveClosure = closure(repo, haves, shallowSet);
  // What the client wants.
  const wantClosure = new Set<string>();
  const boundary = new Set<string>();
  if (depth !== null && Number.isFinite(depth) && depth > 0) {
    const generations = new Map<string, number>();
    const queue: { oid: string; gen: number }[] = [];
    for (const want of wants) {
      const commitOid = peelToCommit(repo, want);
      if (commitOid === null) {
        for (const oid of closure(repo, [want])) wantClosure.add(oid);
      } else queue.push({ oid: commitOid, gen: 1 });
    }
    while (queue.length) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      const known = generations.get(oid);
      if (known !== undefined && known <= gen) continue;
      generations.set(oid, gen);
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      if (gen === depth && commit.parents.length > 0) boundary.add(oid);
      if (gen < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
    for (const oid of generations.keys()) {
      wantClosure.add(oid);
      const commit = getCommit(repo, oid);
      if (commit !== null) collectTree(repo, commit.tree, wantClosure);
    }
  } else {
    for (const oid of closure(repo, wants, shallowSet)) wantClosure.add(oid);
  }
  const send = new Set<string>();
  for (const oid of wantClosure) if (!haveClosure.has(oid)) send.add(oid);
  const pack = cachedPack(repo, send);

  // Response sections are a header line, the section's lines, then a delimiter; the packfile
  // section runs to the closing flush instead.
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    for (const have of haves) {
      if (getCommit(repo, have) !== null) parts.push(pktLine(`ACK ${have}\n`));
    }
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  const shallowLines: string[] = [];
  for (const oid of boundary) if (!shallowSet.has(oid)) shallowLines.push(`shallow ${oid}`);
  for (const oid of shallowArgs) {
    if (wantClosure.has(oid) && !boundary.has(oid)) shallowLines.push(`unshallow ${oid}`);
  }
  if (shallowLines.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandFrame(pack, 1));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Content-Length': String(body.length) });
  res.end(body);
}

function gitUploadPack(repo: Repo, body: Buffer, protocol: string | null, res: ServerResponse): void {
  // Protocol v2: a command line, capability lines, a delimiter, arguments, a flush.
  let firstSection: { lines: Buffer[]; next: number };
  try {
    firstSection = readPktSection(body, 0);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('malformed pkt-line stream');
    return;
  }
  const firstLine = firstSection.lines.length ? lineText(firstSection.lines[0]) : '';
  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length);
    let args: string[] = [];
    // Capability lines share the first section; arguments follow a delimiter packet, which
    // parsePktAt surfaces as a non-data packet inside readPktSection's walk — re-read manually.
    let cursor = 0;
    let sawDelim = false;
    const argLines: Buffer[] = [];
    try {
      for (;;) {
        const pkt = parsePktAt(body, cursor);
        cursor = pkt.next;
        if (pkt.kind === 'delim') {
          sawDelim = true;
          continue;
        }
        if (pkt.kind !== 'data') break;
        if (sawDelim) argLines.push(pkt.payload);
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('malformed pkt-line stream');
      return;
    }
    args = argLines.map(lineText);
    if (command === 'ls-refs') {
      gitLsRefs(repo, args, res);
      return;
    }
    if (command === 'fetch') {
      gitFetch(repo, args, res);
      return;
    }
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`unknown command ${command}`);
    return;
  }
  // Protocol v0 fallback: want/have/done lines, answered with NAK then the pack.
  const wants: string[] = [];
  const haves: string[] = [];
  let sideband = false;
  for (const raw of firstSection.lines) {
    const line = lineText(raw);
    if (line.startsWith('want ')) {
      const parts = line.split(' ');
      wants.push(parts[1]);
      if (parts.slice(2).join(' ').includes('side-band-64k')) sideband = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
  }
  const send = closure(repo, wants);
  for (const oid of closure(repo, haves)) send.delete(oid);
  const pack = buildPack(packObjectsFor(repo, send));
  const parts: Buffer[] = [pktLine('NAK\n')];
  parts.push(sideband ? sidebandFrame(pack, 1) : pack);
  const out = Buffer.concat(parts);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Content-Length': String(out.length) });
  res.end(out);
}

interface RefCommand {
  old: string;
  new: string;
  ref: string;
}

function gitReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  let section: { lines: Buffer[]; next: number };
  try {
    section = readPktSection(body, 0);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('malformed pkt-line stream');
    return;
  }
  const commands: RefCommand[] = [];
  let caps = '';
  section.lines.forEach((raw, index) => {
    let line = lineText(raw);
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0], new: parts[1], ref: parts.slice(2).join(' ') });
  });
  const rest = body.subarray(section.next);
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const entries = readPack(rest);
      for (const entry of entries) {
        if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const pass = (): void => {
      results.push({ ref: command.ref, ok: true });
    };
    if (unpackError !== null) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.new === ZERO_OID) {
      if (current === undefined) fail('reference does not exist');
      else if (command.ref === headTarget) fail('deletion of the current branch prohibited');
      else if (command.old !== ZERO_OID && command.old !== current) fail('reference is not up to date');
      else {
        repo.refs.delete(command.ref);
        pass();
      }
      continue;
    }
    if (!repo.objects.has(command.new)) {
      fail('reference is not up to date');
      continue;
    }
    if (command.old !== ZERO_OID && current === undefined) {
      fail('reference is not up to date');
      continue;
    }
    if (current !== undefined && command.old !== ZERO_OID && command.old !== current) {
      fail('reference is not up to date');
      continue;
    }
    if (current !== undefined && current !== command.new) {
      const newCommit = peelToCommit(repo, command.new);
      const currentCommit = peelToCommit(repo, current);
      if (newCommit !== null && currentCommit !== null && !isAncestor(repo, currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.new);
    pass();
  }
  repo.updatedAt = nowIso();
  if (!caps.includes('report-status')) {
    res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Content-Length': '0' });
    res.end();
    return;
  }
  const reportParts: Buffer[] = [pktLine(unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n')];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  const out = caps.includes('side-band-64k') ? Buffer.concat([sidebandFrame(report, 1), PKT_FLUSH]) : report;
  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Content-Length': String(out.length) });
  res.end(out);
}

// ---------------------------------------------------------------------------------------------
// GraphQL: a small parser and executor for the fixed document set the API is exercised with —
// operations with variables, aliases, arguments (enums, lists, input objects), fragments,
// connections, mutations and the introspection the checks query.

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string' | 'enum'; value: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  alias?: string;
  name: string;
  args: { name: string; value: GqlValue }[];
  selectionSet?: GqlField[];
  fragment?: string; // a spread "...Name"
  inlineOn?: string; // an inline fragment "... on Type"
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: GqlField[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { on: string; selectionSet: GqlField[] }>;
}

function gqlLex(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push(`str:${source.slice(i + 3, end)}`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push(`str:${out}`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(`num:${source.slice(i, j)}`);
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push(`name:${source.slice(i, j)}`);
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = gqlLex(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(symbol: string): void {
    const token = this.next();
    if (token !== symbol) throw new Error(`expected ${symbol}, found ${token}`);
  }

  private name(): string {
    const token = this.next();
    if (!token.startsWith('name:')) throw new Error(`expected a name, found ${token}`);
    return token.slice(5);
  }

  private skipParens(): void {
    // Variable definitions and directives: balanced parentheses, contents not needed beyond
    // variable defaults (unused by the exercised documents).
    if (this.peek() !== '(') return;
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    } while (depth > 0);
  }

  private value(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.name() };
    if (token.startsWith('str:')) return { kind: 'string', value: token.slice(4) };
    if (token.startsWith('num:')) {
      const raw = token.slice(4);
      return /[.eE]/.test(raw) ? { kind: 'float', value: Number(raw) } : { kind: 'int', value: Number(raw) };
    }
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.value());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== '}') {
        const fieldName = this.name();
        this.expect(':');
        fields.push({ name: fieldName, value: this.value() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('name:')) {
      const word = token.slice(5);
      if (word === 'true') return { kind: 'boolean', value: true };
      if (word === 'false') return { kind: 'boolean', value: false };
      if (word === 'null') return { kind: 'null' };
      return { kind: 'enum', value: word };
    }
    throw new Error(`unexpected value token ${token}`);
  }

  private selectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') fields.push(this.selection());
    this.expect('}');
    return fields;
  }

  private selection(): GqlField {
    if (this.peek() === '...') {
      this.next();
      const token = this.peek() ?? '';
      if (token.startsWith('name:') && token.slice(5) === 'on') {
        this.next();
        const on = this.name();
        return { name: '', inlineOn: on, args: [], selectionSet: this.selectionSet() };
      }
      return { name: '', fragment: this.name(), args: [] };
    }
    let fieldName = this.name();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = fieldName;
      fieldName = this.name();
    }
    const args: { name: string; value: GqlValue }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.name();
        this.expect(':');
        args.push({ name: argName, value: this.value() });
      }
      this.expect(')');
    }
    // Directives are skipped: the exercised documents carry none that change meaning here.
    while (this.peek() === '@') {
      this.next();
      this.name();
      this.skipParens();
    }
    const set = this.peek() === '{' ? this.selectionSet() : undefined;
    const field: GqlField = { name: fieldName, args };
    if (alias !== undefined) field.alias = alias;
    if (set !== undefined) field.selectionSet = set;
    return field;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { on: string; selectionSet: GqlField[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as string;
      if (token === '{') {
        operations.push({ type: 'query', selectionSet: this.selectionSet() });
      } else if (token === 'name:query' || token === 'name:mutation') {
        const type = token.slice(5) as 'query' | 'mutation';
        this.next();
        let opName: string | undefined;
        if ((this.peek() ?? '').startsWith('name:')) opName = this.name();
        this.skipParens();
        while (this.peek() === '@') {
          this.next();
          this.name();
          this.skipParens();
        }
        const operation: GqlOperation = { type, selectionSet: this.selectionSet() };
        if (opName !== undefined) operation.name = opName;
        operations.push(operation);
      } else if (token === 'name:fragment') {
        this.next();
        const fragName = this.name();
        const onToken = this.next();
        if (onToken !== 'name:on') throw new Error('fragment without a type condition');
        const on = this.name();
        fragments.set(fragName, { on, selectionSet: this.selectionSet() });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }
}

function gqlValue(node: GqlValue, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => gqlValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = gqlValue(field.value, variables);
      return out;
    }
  }
}

// ---- GraphQL execution ----

interface Wrapped {
  __typename: string;
  __source: unknown;
}

function wrap(typename: string, source: unknown): Wrapped {
  return { __typename: typename, __source: source };
}

function isWrapped(value: unknown): value is Wrapped {
  return value !== null && typeof value === 'object' && typeof (value as Wrapped).__typename === 'string' && '__source' in (value as Wrapped);
}

class GqlFieldError extends Error {}

interface GqlExec {
  variables: Record<string, unknown>;
  fragments: Map<string, { on: string; selectionSet: GqlField[] }>;
  errors: { message: string; path?: (string | number)[] }[];
}

interface ConnSource<T> {
  items: T[];
  args: Record<string, unknown>;
  itemType: string;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function connSlice<T>(source: ConnSource<T>): { slice: T[]; start: number; hasNext: boolean } {
  const after = source.args.after;
  const start = typeof after === 'string' ? indexOfCursor(after) + 1 : 0;
  const first = typeof source.args.first === 'number' ? source.args.first : source.items.length;
  const slice = source.items.slice(start, start + Math.max(0, first));
  return { slice, start, hasNext: start + slice.length < source.items.length };
}

function repoById(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

function repoByGlobalId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  return repoById(Number(parsed.key));
}

/** Decode an Issue/PullRequest global id to its repo and entry. */
function entryByGlobalId(id: unknown): { repo: Repo; entry: IssueOrPull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  const repo = repoById(repoId ?? NaN);
  if (repo === null) return null;
  const entry = repo.entries.get(number ?? NaN);
  return entry === undefined ? null : { repo, entry };
}

function argsOf(field: GqlField, exec: GqlExec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = gqlValue(arg.value, exec.variables);
  return out;
}

type Resolver = (source: never, args: Record<string, unknown>, exec: GqlExec) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => wrap('User', {}),
    repository: (_s, args) => {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? ownedRepo(args.owner, args.name) : null;
      return repo === null ? null : wrap('Repository', repo);
    },
    node: (_s, args) => {
      if (typeof args.id !== 'string') return null;
      const parsed = parseGlobalId(args.id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = repoById(Number(parsed.key));
        return repo === null ? null : wrap('Repository', repo);
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const found = entryByGlobalId(args.id);
        if (found === null) return null;
        return wrap(parsed.type, found);
      }
      if (parsed.type === 'User') return wrap('User', {});
      return null;
    },
    rateLimit: () => wrap('RateLimit', {}),
  },
  User: {
    id: () => globalId('User', String(VIEWER_ID)),
    login: () => VIEWER_LOGIN,
    name: () => VIEWER_NAME,
    email: () => VIEWER_EMAIL,
    databaseId: () => VIEWER_ID,
    url: () => '',
    avatarUrl: () => '',
    isViewer: () => true,
  },
  RateLimit: {
    limit: () => 5000,
    cost: () => 1,
    remaining: () => 4999,
    resetAt: () => isoOf(CLOCK_BASE + 3600),
    used: () => 1,
  },
  Ref: {
    name: (source) => (source as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: (source) => {
      const src = source as { repo: Repo; name: string };
      const oid = resolveCommit(src.repo, src.name);
      return oid === null ? null : wrap('Commit', { repo: src.repo, oid });
    },
  },
  Commit: {
    oid: (source) => (source as { oid: string }).oid,
    id: (source) => globalId('Commit', (source as { oid: string }).oid),
    message: (source) => {
      const src = source as { repo: Repo; oid: string };
      return getCommit(src.repo, src.oid)?.message ?? '';
    },
    committedDate: (source) => {
      const src = source as { repo: Repo; oid: string };
      const commit = getCommit(src.repo, src.oid);
      return commit === null ? isoOf(CLOCK_BASE) : identParts(commit.committer).date;
    },
    tree: (source) => {
      const src = source as { repo: Repo; oid: string };
      const tree = commitTree(src.repo, src.oid);
      return tree === null ? null : wrap('Tree', { repo: src.repo, oid: tree });
    },
  },
  Tree: {
    oid: (source) => (source as { oid: string }).oid,
    id: (source) => globalId('Tree', (source as { oid: string }).oid),
  },
  Label: {
    id: (source) => globalId('Label', (source as Label).name),
    name: (source) => (source as Label).name,
    color: (source) => (source as Label).color,
    description: (source) => (source as Label).description,
  },
  Repository: {
    id: (source) => globalId('Repository', String((source as Repo).id)),
    databaseId: (source) => (source as Repo).id,
    name: (source) => (source as Repo).name,
    nameWithOwner: (source) => `${(source as Repo).owner}/${(source as Repo).name}`,
    owner: () => wrap('User', {}),
    description: (source) => (source as Repo).description,
    isPrivate: (source) => (source as Repo).private,
    visibility: (source) => ((source as Repo).private ? 'PRIVATE' : 'PUBLIC'),
    defaultBranchRef: (source) => wrap('Ref', { repo: source as Repo, name: (source as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasWikiEnabled: () => true,
    isArchived: () => false,
    isFork: () => false,
    url: () => '',
    createdAt: (source) => (source as Repo).createdAt,
    updatedAt: (source) => (source as Repo).updatedAt,
    issue: (source, args) => {
      const repo = source as Repo;
      const entry = repo.entries.get(Number(args.number));
      return entry !== undefined && entry.kind === 'issue' ? wrap('Issue', { repo, entry }) : null;
    },
    issues: (source, args) => {
      const repo = source as Repo;
      let issues = [...repo.entries.values()].filter((entry): entry is Issue => entry.kind === 'issue');
      const states = args.states;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((state) => String(state).toLowerCase());
        issues = issues.filter((issue) => wanted.includes(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy !== null ? 'DESC' : 'ASC';
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return wrap('IssueConnection', { items: issues.map((entry) => ({ repo, entry })), args, itemType: 'Issue' });
    },
    pullRequest: (source, args) => {
      const repo = source as Repo;
      const entry = repo.entries.get(Number(args.number));
      return entry !== undefined && entry.kind === 'pull' ? wrap('PullRequest', { repo, entry }) : null;
    },
    pullRequests: (source, args) => {
      const repo = source as Repo;
      let pulls = [...repo.entries.values()].filter((entry): entry is Pull => entry.kind === 'pull');
      const states = args.states;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((state) => String(state).toLowerCase());
        pulls = pulls.filter((pull) => wanted.includes(pull.state) || (pull.merged && wanted.includes('merged')));
      }
      pulls.sort((a, b) => a.number - b.number);
      return wrap('PullRequestConnection', { items: pulls.map((entry) => ({ repo, entry })), args, itemType: 'PullRequest' });
    },
    labels: (source, args) => {
      const repo = source as Repo;
      return wrap('LabelConnection', { items: [...repo.labels.values()], args, itemType: 'Label' });
    },
  },
  Issue: {
    id: (source) => {
      const src = source as { repo: Repo; entry: Issue };
      return globalId('Issue', `${src.repo.id}:${src.entry.number}`);
    },
    databaseId: (source) => (source as { entry: Issue }).entry.id,
    number: (source) => (source as { entry: Issue }).entry.number,
    title: (source) => (source as { entry: Issue }).entry.title,
    body: (source) => (source as { entry: Issue }).entry.body,
    state: (source) => (source as { entry: Issue }).entry.state.toUpperCase(),
    closed: (source) => (source as { entry: Issue }).entry.state === 'closed',
    createdAt: (source) => (source as { entry: Issue }).entry.createdAt,
    updatedAt: (source) => (source as { entry: Issue }).entry.updatedAt,
    author: () => wrap('User', {}),
    repository: (source) => wrap('Repository', (source as { repo: Repo }).repo),
    url: () => '',
    labels: (source, args) => {
      const src = source as { repo: Repo; entry: Issue };
      const items = src.entry.labels.map((name) => src.repo.labels.get(name) ?? { name, color: 'ededed', description: null });
      return wrap('LabelConnection', { items, args, itemType: 'Label' });
    },
    comments: (source, args) => {
      const src = source as { repo: Repo; entry: Issue };
      const items = src.entry.comments.map((comment) => ({ repo: src.repo, entry: src.entry, comment }));
      return wrap('IssueCommentConnection', { items, args, itemType: 'IssueComment' });
    },
  },
  PullRequest: {
    id: (source) => {
      const src = source as { repo: Repo; entry: Pull };
      return globalId('PullRequest', `${src.repo.id}:${src.entry.number}`);
    },
    databaseId: (source) => (source as { entry: Pull }).entry.id,
    number: (source) => (source as { entry: Pull }).entry.number,
    title: (source) => (source as { entry: Pull }).entry.title,
    body: (source) => (source as { entry: Pull }).entry.body,
    state: (source) => {
      const entry = (source as { entry: Pull }).entry;
      return entry.merged ? 'MERGED' : entry.state.toUpperCase();
    },
    merged: (source) => (source as { entry: Pull }).entry.merged,
    mergedAt: (source) => (source as { entry: Pull }).entry.mergedAt,
    closed: (source) => (source as { entry: Pull }).entry.state === 'closed',
    mergeCommit: (source) => {
      const src = source as { repo: Repo; entry: Pull };
      return src.entry.mergeCommitSha === null ? null : wrap('Commit', { repo: src.repo, oid: src.entry.mergeCommitSha });
    },
    headRefName: (source) => (source as { entry: Pull }).entry.headRef,
    baseRefName: (source) => (source as { entry: Pull }).entry.baseRef,
    headRefOid: (source) => {
      const src = source as { repo: Repo; entry: Pull };
      return resolveCommit(src.repo, src.entry.headRef) ?? ZERO_OID;
    },
    baseRefOid: (source) => {
      const src = source as { repo: Repo; entry: Pull };
      return resolveCommit(src.repo, src.entry.baseRef) ?? ZERO_OID;
    },
    mergeable: (source) => {
      const src = source as { repo: Repo; entry: Pull };
      const result = pullMergeable(src.repo, src.entry);
      return result === null ? 'UNKNOWN' : result ? 'MERGEABLE' : 'CONFLICTING';
    },
    createdAt: (source) => (source as { entry: Pull }).entry.createdAt,
    updatedAt: (source) => (source as { entry: Pull }).entry.updatedAt,
    author: () => wrap('User', {}),
    repository: (source) => wrap('Repository', (source as { repo: Repo }).repo),
    url: () => '',
    files: (source, args) => {
      const src = source as { repo: Repo; entry: Pull };
      const headTip = resolveCommit(src.repo, src.entry.headRef);
      const baseTip = resolveCommit(src.repo, src.entry.baseRef);
      const base = headTip !== null && baseTip !== null ? mergeBase(src.repo, baseTip, headTip) : null;
      const items = diffCommits(src.repo, base, headTip).map((change) => ({
        path: change.filename,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status.toUpperCase(),
      }));
      return wrap('PullRequestFileConnection', { items, args, itemType: 'PullRequestFile' });
    },
    comments: (source, args) => {
      const src = source as { repo: Repo; entry: Pull };
      const items = src.entry.comments.map((comment) => ({ repo: src.repo, entry: src.entry, comment }));
      return wrap('IssueCommentConnection', { items, args, itemType: 'IssueComment' });
    },
  },
  PullRequestFile: {
    path: (source) => (source as { path: string }).path,
    additions: (source) => (source as { additions: number }).additions,
    deletions: (source) => (source as { deletions: number }).deletions,
    changeType: (source) => (source as { changeType: string }).changeType,
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', String((source as { comment: IssueComment }).comment.id)),
    databaseId: (source) => (source as { comment: IssueComment }).comment.id,
    body: (source) => (source as { comment: IssueComment }).comment.body,
    createdAt: (source) => (source as { comment: IssueComment }).comment.createdAt,
    updatedAt: (source) => (source as { comment: IssueComment }).comment.updatedAt,
    author: () => wrap('User', {}),
  },
  Mutation: {
    createIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(input.repositoryId);
      if (repo === null) throw new GqlFieldError('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlFieldError('title is required');
      const stamp = nowIso();
      const issue: Issue = {
        kind: 'issue',
        id: nextIssueId,
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.entries.set(issue.number, issue);
      return wrap('CreateIssuePayload', { issue: { repo, entry: issue } });
    },
    closeIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = entryByGlobalId(input.issueId);
      if (found === null || found.entry.kind !== 'issue') throw new GqlFieldError('issue not found');
      found.entry.state = 'closed';
      found.entry.updatedAt = nowIso();
      return wrap('CloseIssuePayload', { issue: { repo: found.repo, entry: found.entry } });
    },
    createPullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(input.repositoryId);
      if (repo === null) throw new GqlFieldError('repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      if (resolveCommit(repo, head) === null) throw new GqlFieldError(`head branch "${head}" does not exist`);
      if (resolveCommit(repo, base) === null) throw new GqlFieldError(`base branch "${base}" does not exist`);
      const stamp = nowIso();
      const pull: Pull = {
        kind: 'pull',
        id: nextIssueId,
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.entries.set(pull.number, pull);
      return wrap('CreatePullRequestPayload', { pullRequest: { repo, entry: pull } });
    },
    mergePullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = entryByGlobalId(input.pullRequestId);
      if (found === null || found.entry.kind !== 'pull') throw new GqlFieldError('pull request not found');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
      const outcome = mergePull(found.repo, found.entry, method);
      if (!outcome.ok) throw new GqlFieldError(outcome.reason === 'conflict' ? 'Pull Request is not mergeable' : `cannot merge: ${outcome.reason}`);
      return wrap('MergePullRequestPayload', { pullRequest: { repo: found.repo, entry: found.entry } });
    },
    addComment: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = entryByGlobalId(input.subjectId);
      if (found === null) throw new GqlFieldError('subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const stamp = nowIso();
      const comment: IssueComment = { id: nextCommentId, body, createdAt: stamp, updatedAt: stamp };
      nextCommentId += 1;
      found.entry.comments.push(comment);
      found.entry.updatedAt = stamp;
      const node = { repo: found.repo, entry: found.entry, comment };
      return wrap('AddCommentPayload', { commentEdge: { node, itemType: 'IssueComment', cursor: cursorFor(0) } });
    },
  },
  CreateIssuePayload: {
    issue: (source) => wrap('Issue', (source as { issue: unknown }).issue),
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (source) => wrap('Issue', (source as { issue: unknown }).issue),
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => wrap('PullRequest', (source as { pullRequest: unknown }).pullRequest),
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => wrap('PullRequest', (source as { pullRequest: unknown }).pullRequest),
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (source) => wrap('IssueCommentEdge', (source as { commentEdge: unknown }).commentEdge),
    clientMutationId: () => null,
  },
  IssueCommentEdge: {
    node: (source) => wrap('IssueComment', (source as { node: unknown }).node),
    cursor: () => cursorFor(0),
  },
};

// Connection field resolvers, shared by every connection type.
for (const connType of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestFileConnection']) {
  RESOLVERS[connType] = {
    nodes: (source) => {
      const src = source as ConnSource<unknown>;
      return connSlice(src).slice.map((item) => wrap(src.itemType, item));
    },
    edges: (source) => {
      const src = source as ConnSource<unknown>;
      const { slice, start } = connSlice(src);
      return slice.map((item, index) => wrap(`${src.itemType}Edge`, { node: item, cursor: cursorFor(start + index), itemType: src.itemType }));
    },
    pageInfo: (source) => wrap('PageInfo', source),
    totalCount: (source) => (source as ConnSource<unknown>).items.length,
  };
  RESOLVERS[`${connType.replace('Connection', '')}Edge`] = {
    node: (source) => {
      const src = source as { node: unknown; itemType: string };
      return wrap(src.itemType, src.node);
    },
    cursor: (source) => (source as { cursor: string }).cursor,
  };
}
RESOLVERS.PageInfo = {
  hasNextPage: (source) => connSlice(source as ConnSource<unknown>).hasNext,
  hasPreviousPage: (source) => {
    const { start } = connSlice(source as ConnSource<unknown>);
    return start > 0;
  },
  startCursor: (source) => {
    const { slice, start } = connSlice(source as ConnSource<unknown>);
    return slice.length ? cursorFor(start) : null;
  },
  endCursor: (source) => {
    const { slice, start } = connSlice(source as ConnSource<unknown>);
    return slice.length ? cursorFor(start + slice.length - 1) : null;
  },
};

// ---- Introspection ----

const TYPE_DEFS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'rateLimit', 'search'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'avatarUrl', 'isViewer'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'visibility', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'isArchived', 'isFork', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'closed', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'url'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'closed', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'comments', 'author', 'repository', 'createdAt', 'updatedAt', 'url'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'committedDate', 'tree'] },
  Tree: { kind: 'OBJECT', fields: ['id', 'oid'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  RateLimit: { kind: 'OBJECT', fields: ['limit', 'cost', 'remaining', 'resetAt', 'used'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'PULL_REQUEST', 'DISCUSSION', 'CODE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'possibleTypes', 'inputFields', 'interfaces', 'specifiedByURL'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
};

RESOLVERS.__Type = {
  name: (source) => (source as { name: string }).name,
  kind: (source) => TYPE_DEFS[(source as { name: string }).name]?.kind ?? 'OBJECT',
  description: () => null,
  fields: (source) => {
    const def = TYPE_DEFS[(source as { name: string }).name];
    return (def?.fields ?? []).map((name) => wrap('__Field', { name }));
  },
  enumValues: (source) => {
    const def = TYPE_DEFS[(source as { name: string }).name];
    return (def?.enumValues ?? []).map((name) => wrap('__EnumValue', { name }));
  },
  ofType: () => null,
  possibleTypes: () => null,
  inputFields: () => null,
  interfaces: () => [],
  specifiedByURL: () => null,
};
RESOLVERS.__Field = {
  name: (source) => (source as { name: string }).name,
  description: () => null,
  type: () => wrap('__Type', { name: 'String' }),
  args: () => [],
  isDeprecated: () => false,
  deprecationReason: () => null,
};
RESOLVERS.__EnumValue = {
  name: (source) => (source as { name: string }).name,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
};

// ---- Selection application ----

function completeValue(value: unknown, field: GqlField, exec: GqlExec, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => completeValue(item, field, exec, [...path, index]));
  if (isWrapped(value)) {
    if (field.selectionSet === undefined) return null;
    return resolveObject(value.__typename, value.__source, field.selectionSet, exec, path);
  }
  return value;
}

function resolveObject(typename: string, source: unknown, selectionSet: GqlField[], exec: GqlExec, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selectionSet) {
    if (field.fragment !== undefined) {
      const fragment = exec.fragments.get(field.fragment);
      if (fragment !== undefined && fragment.on === typename) {
        Object.assign(out, resolveObject(typename, source, fragment.selectionSet, exec, path));
      }
      continue;
    }
    if (field.inlineOn !== undefined) {
      if (field.inlineOn === typename && field.selectionSet !== undefined) {
        Object.assign(out, resolveObject(typename, source, field.selectionSet, exec, path));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typename;
      continue;
    }
    if (field.name === '__type' && typename === 'Query') {
      const args = argsOf(field, exec);
      const def = typeof args.name === 'string' ? TYPE_DEFS[args.name] : undefined;
      out[key] = def === undefined ? null : completeValue(wrap('__Type', { name: args.name as string }), field, exec, [...path, key]);
      continue;
    }
    if (field.name === '__schema' && typename === 'Query') {
      out[key] = completeValue(wrap('__Schema', {}), field, exec, [...path, key]);
      continue;
    }
    const resolver = RESOLVERS[typename]?.[field.name];
    if (resolver === undefined) {
      exec.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typename}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    try {
      const raw = resolver(source as never, argsOf(field, exec), exec);
      out[key] = completeValue(raw, field, exec, [...path, key]);
    } catch (error) {
      exec.errors.push({ message: error instanceof Error ? error.message : String(error), path: [...path, key] });
      out[key] = null;
    }
  }
  return out;
}

RESOLVERS.__Schema = {
  types: () => Object.keys(TYPE_DEFS).map((name) => wrap('__Type', { name })),
  queryType: () => wrap('__Type', { name: 'Query' }),
  mutationType: () => wrap('__Type', { name: 'Mutation' }),
  subscriptionType: () => null,
  directives: () => [],
};

function executeGraphQL(payload: Record<string, unknown>): Record<string, unknown> {
  const query = typeof payload.query === 'string' ? payload.query : '';
  let document: GqlDocument;
  try {
    document = new GqlParser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : undefined;
  const operation = document.operations.find((op) => op.name === operationName) ?? document.operations[0];
  const variables = (payload.variables ?? {}) as Record<string, unknown>;
  const exec: GqlExec = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveObject(rootType, {}, operation.selectionSet, exec, []);
  const result: Record<string, unknown> = { data };
  if (exec.errors.length) result.errors = exec.errors;
  return result;
}

function handleGraphQL(res: ServerResponse, body: unknown): void {
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((item) => executeGraphQL((item ?? {}) as Record<string, unknown>)));
    return;
  }
  sendJson(res, 200, executeGraphQL((body ?? {}) as Record<string, unknown>));
}

// ---------------------------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over streamable HTTP — server/discover (the modern handshake), the legacy
// initialize, and six tools that act on the very store REST reads.

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface McpToolOutcome {
  payload?: unknown;
  errorText?: string;
}

function mcpToolCall(name: string, args: Record<string, unknown>, base: string): McpToolOutcome {
  const argString = (key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  const needRepo = (): Repo | null => {
    const owner = argString('owner');
    const repoName = argString('repo');
    if (owner === undefined || repoName === undefined) return null;
    return ownedRepo(owner, repoName);
  };
  switch (name) {
    case 'create_repo': {
      const repoName = argString('name') as string;
      if (repos.has(repoKey(VIEWER_LOGIN, repoName))) return { errorText: `name already exists on this account: ${repoName}` };
      const repo = createRepoRecord(repoName, args.private === true, argString('description') ?? null);
      return { payload: repoJson(repo, base) };
    }
    case 'get_repo': {
      const repo = needRepo();
      if (repo === null) return { errorText: 'repository not found' };
      return { payload: repoJson(repo, base) };
    }
    case 'create_issue': {
      const repo = needRepo();
      if (repo === null) return { errorText: 'repository not found' };
      const stamp = nowIso();
      const issue: Issue = {
        kind: 'issue',
        id: nextIssueId,
        number: repo.nextNumber,
        title: argString('title') as string,
        body: argString('body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.entries.set(issue.number, issue);
      return { payload: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = needRepo();
      if (repo === null) return { errorText: 'repository not found' };
      const state = argString('state') ?? 'open';
      let issues = [...repo.entries.values()].filter((entry): entry is Issue => entry.kind === 'issue');
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return { payload: issues.map((issue) => issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = needRepo();
      if (repo === null) return { errorText: 'repository not found' };
      const head = argString('head') as string;
      const baseRef = argString('base') as string;
      if (resolveCommit(repo, head) === null) return { errorText: `head branch "${head}" does not exist` };
      if (resolveCommit(repo, baseRef) === null) return { errorText: `base branch "${baseRef}" does not exist` };
      const stamp = nowIso();
      const pull: Pull = {
        kind: 'pull',
        id: nextIssueId,
        number: repo.nextNumber,
        title: argString('title') as string,
        body: argString('body') ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.entries.set(pull.number, pull);
      return { payload: pullJson(repo, pull, base) };
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      if (repo === null) return { errorText: 'repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const entry = repo.entries.get(number);
      if (entry === undefined || entry.kind !== 'pull') return { errorText: 'pull request not found' };
      const outcome = mergePull(repo, entry, 'merge');
      if (!outcome.ok) return { errorText: outcome.reason === 'conflict' ? 'Pull Request is not mergeable' : `cannot merge: ${outcome.reason}` };
      return { payload: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    default:
      return { errorText: `unknown tool ${name}` };
  }
}

const MCP_REQUIRED_ARGS: Record<string, string[]> = Object.fromEntries(
  MCP_TOOLS.map((tool) => [tool.name, (tool.inputSchema.required ?? []) as string[]]),
);

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpDispatch(message: Record<string, unknown>, base: string): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (id === undefined) return null; // a notification: accepted, never answered
  switch (method) {
    case 'server/discover':
      return mcpResult(id, {
        supportedVersions: MCP_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = MCP_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return mcpResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case 'ping':
      return mcpResult(id, {});
    case 'tools/list':
      return mcpResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return mcpError(id, -32602, `unknown tool: ${name}`);
      const required = MCP_REQUIRED_ARGS[name] ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null);
      if (missing.length) return mcpError(id, -32602, `missing required argument: ${missing[0]}`);
      const outcome = mcpToolCall(name, args, base);
      if (outcome.errorText !== undefined) {
        return mcpResult(id, { content: [{ type: 'text', text: outcome.errorText }], isError: true });
      }
      const text = JSON.stringify(outcome.payload ?? null);
      return mcpResult(id, { content: [{ type: 'text', text }], structuredContent: outcome.payload ?? null, isError: false });
    }
    case 'resources/list':
      return mcpResult(id, { resources: [] });
    case 'prompts/list':
      return mcpResult(id, { prompts: [] });
    default:
      return mcpError(id, -32601, `method not found: ${method}`);
  }
}

function handleMcp(res: ServerResponse, body: unknown, base: string): void {
  if (Array.isArray(body)) {
    const answers: Record<string, unknown>[] = [];
    for (const item of body) {
      if (item !== null && typeof item === 'object') {
        const answer = mcpDispatch(item as Record<string, unknown>, base);
        if (answer !== null) answers.push(answer);
      }
    }
    sendJson(res, 200, answers);
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const answer = mcpDispatch(body as Record<string, unknown>, base);
  if (answer === null) {
    res.writeHead(202, { 'Content-Length': '0' });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

// ---------------------------------------------------------------------------------------------
// The app: routing and the bearer-token gate.

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const method = (req.method ?? 'GET').toUpperCase();
  const base = `http://${req.headers.host ?? 'localhost'}`;

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+?)\.git(?:\/(.*))?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const sub = gitMatch[3] ?? '';
    const repo = ownedRepo(owner, name);
    if (repo === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('repository not found');
      return;
    }
    const protocol = typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : null;
    if (sub === 'info/refs' && method === 'GET') {
      gitInfoRefs(repo, url.searchParams.get('service') ?? '', protocol, res);
      return;
    }
    if (sub === 'git-upload-pack' && method === 'POST') {
      gitUploadPack(repo, await readBody(req), protocol, res);
      return;
    }
    if (sub === 'git-receive-pack' && method === 'POST') {
      gitReceivePack(repo, await readBody(req), res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp') {
    if (!authorized(req)) {
      if (path === '/mcp') sendJson(res, 401, mcpError(null, -32001, 'Unauthorized'));
      else sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    if (path === '/mcp' && method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown = null;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        if (path === '/mcp') sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
        else sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
    }
    if (path === '/api/graphql') {
      handleGraphQL(res, parsed);
      return;
    }
    if (path === '/mcp') {
      handleMcp(res, parsed, base);
      return;
    }
    const segments =
      path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').map((segment) => decodeURIComponent(segment));
    const ctx: Ctx = {
      method,
      url,
      segments,
      body: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null,
      base,
    };
    handleRest(ctx, res);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  return createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      // A malformed request must never take the forge down with it.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${error instanceof Error ? error.message : String(error)}` });
        else res.end();
      } catch {
        // the socket is already gone
      }
    });
  });
}
