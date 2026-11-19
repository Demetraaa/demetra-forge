// git-core.ts — the git object machinery for the forge: sha1 object store, packfile read/write,
// pkt-line framing, object parsing and the reachability math upload-pack negotiates with.
// Node stdlib only (node:crypto, node:zlib); no git binary, no npm packages.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const OID_PATTERN = /^[0-9a-f]{40}$/;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The object id of a (type, data) pair: sha1 of "<type> <length>\0<data>". */
export function objectId(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ----------------------------------------------------------------------------------------------
// pkt-line framing

export const PKT_MAX_PAYLOAD = 65516;

/** Encode one data packet: 4 lowercase hex length digits (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error(`pkt-line payload of ${data.length} bytes is too long`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Decode every complete packet in `buffer` starting at `offset`. Returns the packets and the offset
 * just past the last one; the bytes from there to the end of the buffer are the caller's remainder
 * (for receive-pack, the pack that follows the command list). Throws on a malformed length prefix.
 */
export function decodePktLines(buffer: Buffer, offset = 0): { packets: PktPacket[]; end: number } {
  const packets: PktPacket[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const header = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4) throw new Error(`invalid pkt-line length ${length}`);
    if (at + length > buffer.length) throw new Error('pkt-line overruns the buffer');
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, end: at };
}

/** Decode the single packet starting at `offset`; returns it and the offset just past it. */
export function readPktPacket(buffer: Buffer, offset: number): { packet: PktPacket; end: number } {
  if (offset + 4 > buffer.length) throw new Error('pkt-line header overruns the buffer');
  const header = buffer.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
  const length = parseInt(header, 16);
  if (length === 0) return { packet: { kind: 'flush' }, end: offset + 4 };
  if (length === 1) return { packet: { kind: 'delim' }, end: offset + 4 };
  if (length === 2) return { packet: { kind: 'response-end' }, end: offset + 4 };
  if (length < 4) throw new Error(`invalid pkt-line length ${length}`);
  if (offset + length > buffer.length) throw new Error('pkt-line overruns the buffer');
  return { packet: { kind: 'data', payload: buffer.subarray(offset + 4, offset + length) }, end: offset + length };
}

/** Split a byte stream into pkt-line data packets whose payloads are `chunkSize` data bytes behind one band byte. */
export function sidebandPackets(data: Buffer, band: number, chunkSize = 16384): Buffer[] {
  const packets: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunkSize) {
    const slice = data.subarray(at, Math.min(data.length, at + chunkSize));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return packets;
}

// ----------------------------------------------------------------------------------------------
// Object parsing

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  /** Committer timestamp (seconds since epoch), 0 when unparseable. */
  readonly time: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  let tree = '';
  const parents: string[] = [];
  let time = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
    else if (line.startsWith('committer ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) time = Number(match[1]);
    }
  }
  return { tree, parents, time };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7, 47);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
  }
  return { object, type, tag };
}

/** Follow an annotated-tag chain to the commit (or other object) it ultimately names. */
export function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The object a tag chain ends at (any type), or null when a link is missing. */
export function peelTag(store: Store, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

// ----------------------------------------------------------------------------------------------
// The store

/** Every object the forge holds, keyed by sha1, plus nothing else: repos live in app.ts. */
export class Store {
  readonly objects = new Map<string, GitObject>();

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** Store `data` as an object of `type`; returns its id. Idempotent. */
  add(type: GitObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  put(oid: string, object: GitObject): void {
    this.objects.set(oid, object);
  }
}

// ----------------------------------------------------------------------------------------------
// Reachability

/**
 * Every object reachable from `tips`: commits walk to parents and trees, trees to entries, tags to
 * their target. `shallowStops` names commits whose parents are NOT walked (the client's shallow
 * boundary, when computing what a fetch may exclude). Missing objects are skipped silently.
 */
export function reachable(store: Store, tips: Iterable<string>, shallowStops?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      if (info.tree) stack.push(info.tree);
      if (!shallowStops || !shallowStops.has(oid)) stack.push(...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) stack.push(target);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or reachable from it by parent links alone. */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

// ----------------------------------------------------------------------------------------------
// Packfiles

/** Inflate one zlib stream that starts at `offset`; resolves with the data and the bytes consumed. */
function inflateAt(buffer: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesWritten }));
    stream.on('error', reject);
    stream.end(buffer.subarray(offset));
  });
}

/** Apply a git delta (`delta` bytes) to `base`, producing the target bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta varint overruns the delta');
      const byte = delta[at];
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, the delta expects ${sourceSize}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[at]; at += 1; }
      if (op & 0x02) { offset += delta[at] * 2 ** 8; at += 1; }
      if (op & 0x04) { offset += delta[at] * 2 ** 16; at += 1; }
      if (op & 0x08) { offset += delta[at] * 2 ** 24; at += 1; }
      if (op & 0x10) { size = delta[at]; at += 1; }
      if (op & 0x20) { size += delta[at] * 2 ** 8; at += 1; }
      if (op & 0x40) { size += delta[at] * 2 ** 16; at += 1; }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy overruns the base');
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      if (at + op > delta.length) throw new Error('delta insert overruns the delta');
      parts.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, the header promised ${targetSize}`);
  }
  return result;
}

export interface PackRead {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
  readonly declaredCount: number;
}

interface PackEntry {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly offset: number;
  readonly baseOffset?: number;
  readonly baseOid?: string;
  readonly isDelta: boolean;
}

/**
 * Parse a packfile (version 2 or 3), resolving ofs-delta and ref-delta chains, and verify the
 * trailing sha1 over every preceding byte. `resolveExternal` supplies bases the pack itself does
 * not carry (thin packs against objects the receiver already holds). Throws on any corruption.
 */
export async function readPack(
  pack: Buffer,
  resolveExternal?: (oid: string) => GitObject | undefined,
): Promise<PackRead> {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const declaredCount = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum does not match its bytes');

  const end = pack.length - 20;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let at = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    if (at >= end) throw new Error('pack ends inside its object table');
    const entryOffset = at;
    let byte = pack[at];
    at += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at];
      at += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // ofs-delta: a negative offset back to the base entry, in git's offset encoding.
      byte = pack[at];
      at += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at];
        at += 1;
        back = (back + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const inflated = await inflateAt(pack, at);
    at += inflated.consumed;
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} inflated to ${inflated.data.length} bytes, the header says ${size}`);
    }
    const isDelta = typeCode === 6 || typeCode === 7;
    const entry: PackEntry = {
      type: isDelta ? 'blob' : (CODE_TYPES[typeCode] as GitObjectType),
      data: inflated.data,
      offset: entryOffset,
      baseOffset,
      baseOid,
      isDelta,
    };
    if (!isDelta && !CODE_TYPES[typeCode]) throw new Error(`pack entry type code ${typeCode} is unknown`);
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (at !== end) throw new Error(`pack has ${end - at} stray byte(s) after its last entry`);

  // Resolve deltas iteratively: an entry is done once its base is done.
  const resolved = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  let pending = [...entries];
  while (pending.length) {
    const next: PackEntry[] = [];
    let progressed = false;
    for (const entry of pending) {
      if (!entry.isDelta) {
        const object: GitObject = { type: entry.type, data: entry.data };
        resolved.set(entry.offset, object);
        objects.set(objectId(object.type, object.data), object);
        progressed = true;
        continue;
      }
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) base = resolved.get(entry.baseOffset);
      else if (entry.baseOid !== undefined) base = objects.get(entry.baseOid) ?? resolveExternal?.(entry.baseOid);
      if (!base) {
        next.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      resolved.set(entry.offset, object);
      objects.set(objectId(object.type, object.data), object);
      deltaCount += 1;
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta chain does not resolve');
    pending = next;
  }
  return { objects, deltaCount, declaredCount };
}

/** Serialize objects into a self-contained version-2 pack (no deltas), with a valid sha1 trailer. */
export function writePack(objects: Iterable<readonly [string, GitObject]>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const [, object] of list) {
    const size = object.data.length;
    const first = (TYPE_CODES[object.type] << 4) | (size & 0x0f);
    const bytes: number[] = [];
    let rest = Math.floor(size / 16);
    let lead = first;
    if (rest > 0) lead |= 0x80;
    bytes.push(lead);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ----------------------------------------------------------------------------------------------
// Fetch planning

export interface FetchPlan {
  /** The objects to pack, in a stable order (commits first, then trees, then the rest). */
  readonly objects: Array<readonly [string, GitObject]>;
  /** Boundary commits to report as `shallow`: sent (or held) commits whose parents stay behind. */
  readonly shallow: string[];
  /** Client shallow commits that stop being boundary after this fetch. */
  readonly unshallow: string[];
}

export interface FetchRequestShape {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  /** The client's current shallow boundary, from its `shallow` lines. */
  readonly clientShallow: ReadonlySet<string>;
  readonly depth: number | null;
  readonly deepenSince: number | null;
  /** Extra tips whose history is excluded outright (`deepen-not`, already resolved to oids). */
  readonly deepenNotTips: readonly string[];
}

/**
 * Work out what one fetch sends: the closure of the wants, minus everything reachable from the
 * haves, cut at the requested depth (or deepen-since time). Tag wants contribute their tag objects
 * and peel to a commit root. The boundary bookkeeping follows git's shallow rules: a commit is
 * shallow when one of its parents is neither sent nor already held unshallowed by the client.
 */
export function planFetch(store: Store, request: FetchRequestShape): FetchPlan {
  const excluded = reachable(store, [...request.haves, ...request.deepenNotTips], request.clientShallow);

  // Resolve wants to commit roots, keeping tag objects themselves for the pack.
  const extra = new Set<string>();
  const roots: string[] = [];
  for (const want of request.wants) {
    let current = want;
    for (let hops = 0; hops < 32; hops += 1) {
      const object = store.get(current);
      if (!object) break;
      if (object.type === 'tag') {
        extra.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') roots.push(current);
      else extra.add(current);
      break;
    }
  }

  const limited = request.depth !== null || request.deepenSince !== null;
  const included = new Map<string, number>();
  // Walk by generation from the wants. An excluded commit is never sent, and its history is not
  // walked either — the client holds it — UNLESS it sits on the client's shallow boundary: then
  // its parents are not held, and a deepen request must pass through it to reach them.
  const visited = new Map<string, number>();
  let frontier = [...new Set(roots)];
  let generation = 1;
  while (frontier.length) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (visited.has(oid)) continue;
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      if (request.depth !== null && generation > request.depth) continue;
      if (request.deepenSince !== null && generation > 1) {
        if (parseCommit(object.data).time < request.deepenSince) continue;
      }
      visited.set(oid, generation);
      const held = excluded.has(oid);
      if (!held) included.set(oid, generation);
      if (!held || request.clientShallow.has(oid)) next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
    generation += 1;
  }

  // Boundary: an included commit whose parent exists but is neither included nor excluded.
  const shallow: string[] = [];
  if (limited || request.clientShallow.size > 0) {
    for (const oid of included.keys()) {
      const object = store.get(oid);
      if (!object) continue;
      const { parents } = parseCommit(object.data);
      const cut = parents.some((parent) => store.has(parent) && !included.has(parent) && !excluded.has(parent));
      if (cut) shallow.push(oid);
    }
  }
  const shallowSet = new Set(shallow);

  // Unshallow: a former boundary commit, now held, whose parents are all included or excluded.
  const unshallow: string[] = [];
  for (const oid of request.clientShallow) {
    if (shallowSet.has(oid)) continue;
    if (!included.has(oid) && !excluded.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    const { parents } = parseCommit(object.data);
    if (parents.every((parent) => included.has(parent) || excluded.has(parent) || !store.has(parent))) {
      unshallow.push(oid);
    }
  }

  // The send set: included commits, the tag/extra wants, and the full tree closure of the commits —
  // minus everything the client already reaches from its haves.
  const send = new Set<string>();
  for (const oid of included.keys()) send.add(oid);
  for (const oid of extra) if (!excluded.has(oid)) send.add(oid);
  const treeStack: string[] = [];
  for (const oid of included.keys()) {
    const object = store.get(oid);
    if (object) treeStack.push(parseCommit(object.data).tree);
  }
  while (treeStack.length) {
    const oid = treeStack.pop() as string;
    if (send.has(oid) || excluded.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    send.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) treeStack.push(entry.oid);
  }

  const commits: Array<readonly [string, GitObject]> = [];
  const trees: Array<readonly [string, GitObject]> = [];
  const rest: Array<readonly [string, GitObject]> = [];
  for (const oid of send) {
    const object = store.get(oid);
    if (!object) continue;
    if (object.type === 'commit') commits.push([oid, object]);
    else if (object.type === 'tree') trees.push([oid, object]);
    else rest.push([oid, object]);
  }
  return { objects: [...commits, ...trees, ...rest], shallow, unshallow };
}
