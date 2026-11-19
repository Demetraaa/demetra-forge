// app.ts — the forge server: git smart HTTP (protocol v2 + v0), the REST v3 surface (repos,
// contents, git database, branches, commits, labels, issues, comments, pull requests + squash
// merge), the GraphQL v4 API at /api/graphql, and the MCP endpoint at /mcp.
//
// One in-memory store holds every git object; repositories are metadata plus a ref table over
// it, and the issue/pull/label records live beside the refs so every surface (REST, GraphQL,
// MCP) reads and writes the same objects. The single credential is MAKEFUN_SHOP_TOKEN; the
// login it names is the scenario's viewer, exactly as the conformance SDK derives it
// (sdk/conformance/wire.ts). REST-created commits use the deterministic clock (`tick()`, based
// on MAKEFUN_TRIAL_NOW) and the viewer identity, so replays stay byte-stable.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  Store,
  ZERO_OID,
  OID_PATTERN,
  pktLine,
  pktFlush,
  pktDelim,
  readPktPacket,
  sidebandPackets,
  readPack,
  writePack,
  planFetch,
  peelTag,
  peelToCommit,
  isAncestor,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git-core.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'makefun-forge/1.0';

/** The user the shop token names (the fixed scenario viewer). */
const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

// ----------------------------------------------------------------------------------------------
// State

const store = new Store();

interface LabelRec {
  readonly id: number;
  name: string;
  color: string;
  description: string;
}

interface CommentRec {
  readonly id: number;
  body: string;
  readonly createdAtSec: number;
  updatedAtSec: number;
}

interface IssueRec {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  readonly createdAtSec: number;
  updatedAtSec: number;
  closedAtSec: number | null;
  /** Global creation order (list sorting that survives equal timestamps). */
  readonly seq: number;
}

interface PullRec {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  /** Branch tips when the pull was opened (fallbacks when a branch later moves or is deleted). */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  readonly createdAtSec: number;
  updatedAtSec: number;
  closedAtSec: number | null;
  readonly seq: number;
}

interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** The ref HEAD is a symref to. */
  head: string;
  readonly refs: Map<string, string>;
  readonly createdAtSec: number;
  readonly labels: Map<string, LabelRec>;
  readonly issues: Map<number, IssueRec>;
  readonly pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextRecordId = 1;
let nextLabelId = 1;
let nextCommentId = 1;
let orderSeq = 0;
let requestSeq = 0;
let clockSeq = 0;

/** Deterministic clock base: the trial's opening time when the env provides it. */
const EPOCH_SEC = ((): number => {
  const parsed = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_704_067_200;
})();

function tick(): number {
  clockSeq += 1;
  return EPOCH_SEC + clockSeq;
}

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    type: VIEWER.type,
    name: VIEWER.name,
    email: VIEWER.email,
    site_admin: false,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const stamp = iso(repo.createdAtSec);
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://forge.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge.invalid:${repo.owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_pull_requests: true,
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(),
    author: userJson(),
    created_at: iso(comment.createdAtSec),
    updated_at: iso(comment.updatedAtSec),
  };
}

function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name.toLowerCase()))
      .filter((label): label is LabelRec => label !== undefined)
      .map(labelJson),
    user: userJson(),
    author: userJson(),
    comments: issue.comments.length,
    created_at: iso(issue.createdAtSec),
    updated_at: iso(issue.updatedAtSec),
    closed_at: issue.closedAtSec === null ? null : iso(issue.closedAtSec),
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The current tip commit of a branch name (or full ref), or null when it does not resolve. */
function branchTip(repo: Repo, refOrBranch: string): string | null {
  const oid = resolveRef(repo, refOrBranch);
  if (oid === null) return null;
  return peelToCommit(store, oid) ?? oid;
}

function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = branchTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    author: userJson(),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : iso(pull.mergedAtSec),
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    comments: pull.comments.length,
    created_at: iso(pull.createdAtSec),
    updated_at: iso(pull.updatedAtSec),
    closed_at: pull.closedAtSec === null ? null : iso(pull.closedAtSec),
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ----------------------------------------------------------------------------------------------
// Git tree helpers (contents API, diffs, merges all walk the same flattened maps)

function treeEntriesOf(treeOid: string | null): TreeEntry[] {
  if (treeOid === null) return [];
  const object = store.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** Serialize tree entries (sorted the git way) and store the tree; returns its oid. */
function buildTree(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return store.add('tree', Buffer.concat(parts));
}

interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** Every file under a tree, keyed by its slash path. */
function flattenTree(treeOid: string | null, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  for (const entry of treeEntriesOf(treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild a tree oid from a flattened file map. */
function unflattenTree(flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return buildTree(entries);
  };
  return build(root);
}

type PathLookup =
  | { readonly kind: 'file'; readonly oid: string; readonly mode: string }
  | { readonly kind: 'dir'; readonly treeOid: string }
  | null;

/** Resolve a slash path inside a tree: a file, a directory, or nothing. */
function lookupPath(treeOid: string | null, path: string): PathLookup {
  if (treeOid === null) return null;
  if (path === '' || path === '/') return { kind: 'dir', treeOid };
  const segments = path.split('/');
  let current: string | null = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entry = treeEntriesOf(current).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', treeOid: entry.oid } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** A commit oid's tree oid, or null. */
function commitTreeOf(commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const object = store.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  const tree = parseCommit(object.data).tree;
  return tree === '' ? null : tree;
}

/**
 * Resolve a ref-ish string to the oid it names in this repo: a full ref, a branch or tag name,
 * `HEAD`, or a raw commit oid. Null when nothing matches.
 */
function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') {
    const oid = repo.refs.get(repo.head);
    return oid ?? null;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  for (const candidate of [`refs/heads/${ref}`, `refs/tags/${ref}`]) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return oid;
  }
  if (OID_PATTERN.test(ref) && store.has(ref)) return ref;
  return null;
}

/** Write a commit object with the viewer identity at the deterministic clock; returns its oid. */
function makeCommit(treeOid: string, parents: readonly string[], message: string): string {
  const at = tick();
  const ident = `${VIEWER.name} <${VIEWER.email}> ${at} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return store.add('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

interface CommitView {
  authorName: string;
  authorEmail: string;
  authorSec: number;
  committerName: string;
  committerEmail: string;
  committerSec: number;
  message: string;
  tree: string;
  parents: string[];
}

function commitView(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const view: CommitView = {
    authorName: '',
    authorEmail: '',
    authorSec: 0,
    committerName: '',
    committerEmail: '',
    committerSec: 0,
    message: split >= 0 ? text.slice(split + 2).replace(/\n$/, '') : '',
    tree: '',
    parents: [],
  };
  const ident = (line: string): { name: string; email: string; sec: number } => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    return match
      ? { name: match[1] as string, email: match[2] as string, sec: Number(match[3]) }
      : { name: line, email: '', sec: 0 };
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7, 47));
    else if (line.startsWith('author ')) {
      const parsed = ident(line.slice(7));
      view.authorName = parsed.name;
      view.authorEmail = parsed.email;
      view.authorSec = parsed.sec;
    } else if (line.startsWith('committer ')) {
      const parsed = ident(line.slice(10));
      view.committerName = parsed.name;
      view.committerEmail = parsed.email;
      view.committerSec = parsed.sec;
    }
  }
  return view;
}

function commitJson(oid: string): Record<string, unknown> | null {
  const object = store.get(oid);
  if (!object || object.type !== 'commit') return null;
  const view = commitView(object.data);
  const person = (name: string, email: string, sec: number): Record<string, unknown> => ({
    name,
    email,
    date: iso(sec || EPOCH_SEC),
  });
  return {
    sha: oid,
    node_id: `C_${oid.slice(0, 16)}`,
    commit: {
      author: person(view.authorName, view.authorEmail, view.authorSec),
      committer: person(view.committerName, view.committerEmail, view.committerSec),
      message: view.message,
      tree: { sha: view.tree },
      comment_count: 0,
    },
    author: view.authorEmail === VIEWER.email ? userJson() : null,
    committer: view.committerEmail === VIEWER.email ? userJson() : null,
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

/** Commits reachable from a tip, newest first (DFS pre-order over parents, deduplicated). */
function listCommits(tip: string, limit = 10_000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** The best common ancestor of two commits (first shared commit in breadth-first order), or null. */
function mergeBaseOf(a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOf = (tip: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      queue.push(...parseCommit(object.data).parents);
    }
    return seen;
  };
  const fromA = ancestorsOf(a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

function blobText(oid: string): string {
  const object = store.get(oid);
  return object && object.type === 'blob' ? object.data.toString('utf8') : '';
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Line-level added/deleted counts between two texts, via a longest-common-subsequence walk. */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    // Very large files: fall back to whole-file counts rather than a quadratic table.
    return { additions: m, deletions: n };
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] =
        oldLines[i] === newLines[j]
          ? (dp[(i + 1) * (m + 1) + (j + 1)] as number) + 1
          : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + (j + 1)] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: m - common, deletions: n - common };
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The file changes between two trees (the pull-request files view). */
function diffTrees(fromTree: string | null, toTree: string | null): FileChange[] {
  const from = flattenTree(fromTree);
  const to = flattenTree(toTree);
  const changes: FileChange[] = [];
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before && !after) {
      const deletions = countLines(blobText(before.oid));
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: before.oid });
    } else if (!before && after) {
      const additions = countLines(blobText(after.oid));
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: after.oid });
    } else if (before && after && before.oid !== after.oid) {
      const { additions, deletions } = lineDiffCounts(blobText(before.oid), blobText(after.oid));
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: after.oid });
    }
  }
  return changes;
}

/**
 * A three-way tree merge for squash merges: apply the head's changes (against the merge base)
 * onto the current base tree. Returns the merged flat map, or null on a conflict (both sides
 * changed the same path to different contents).
 */
function threeWayMerge(
  baseTreeOid: string | null,
  currentTreeOid: string | null,
  headTreeOid: string | null,
): Map<string, FlatEntry> | null {
  const base = flattenTree(baseTreeOid);
  const current = flattenTree(currentTreeOid);
  const head = flattenTree(headTreeOid);
  const merged = new Map(current);
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const inBase = base.get(path);
    const inHead = head.get(path);
    const inCurrent = current.get(path);
    const headChanged = (inBase?.oid ?? null) !== (inHead?.oid ?? null);
    if (!headChanged) continue;
    const currentChanged = (inBase?.oid ?? null) !== (inCurrent?.oid ?? null);
    if (currentChanged && (inCurrent?.oid ?? null) !== (inHead?.oid ?? null)) return null;
    if (inHead) merged.set(path, inHead);
    else merged.delete(path);
  }
  return merged;
}

/** Whether a pull request can merge cleanly right now (drives GraphQL `mergeable`). */
function pullMergeable(repo: Repo, pull: PullRec): boolean {
  if (pull.merged) return false;
  const baseTip = branchTip(repo, `refs/heads/${pull.baseRef}`);
  const headTip = branchTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (baseTip === null) return false;
  const base = mergeBaseOf(baseTip, headTip);
  if (base === null) return false;
  return threeWayMerge(commitTreeOf(base), commitTreeOf(baseTip), commitTreeOf(headTip)) !== null;
}

type MergeOutcome =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: 'conflict' | 'not-open' | 'missing' };

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the three-way
 * merge of the head's changes onto the base tip. Shared by REST, GraphQL and MCP.
 */
function mergePull(repo: Repo, pull: PullRec): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'not-open' };
  const baseTip = branchTip(repo, `refs/heads/${pull.baseRef}`);
  const headTip = branchTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (baseTip === null) return { ok: false, reason: 'missing' };
  const base = mergeBaseOf(baseTip, headTip);
  if (base === null) return { ok: false, reason: 'conflict' };
  const merged = threeWayMerge(commitTreeOf(base), commitTreeOf(baseTip), commitTreeOf(headTip));
  if (merged === null) return { ok: false, reason: 'conflict' };
  const treeOid = unflattenTree(merged);
  const sha = makeCommit(treeOid, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const at = tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAtSec = at;
  pull.closedAtSec = at;
  pull.updatedAtSec = at;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

// ----------------------------------------------------------------------------------------------
// HTTP plumbing

function requestId(): string {
  requestSeq += 1;
  return `${requestSeq.toString(16)}-${randomBytes(6).toString('hex')}`;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

const MAX_BODY = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token on the request, or null. Also accepts git's Basic password form. */
function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (header.startsWith('token ')) return header.slice(6);
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon >= 0 ? decoded.slice(colon + 1) : decoded;
  }
  return null;
}

/** True when the request carries the shop token. With no token configured, any bearer passes. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = presentedToken(req);
  if (presented === null) return false;
  if (expected === '') return presented.length > 0;
  return presented === expected;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

/** Parse a JSON request body; answers 400 and returns undefined on malformed JSON. */
async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { message: 'Invalid request body' });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return undefined;
  }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'entry';
  return `http://${host}`;
}

/** Parse a positive pagination pair out of a query, GitHub-style (defaults 30 / 1, cap 100). */
function pageParams(url: URL): { perPage: number; page: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
  };
}

/** Send one page of a list with GitHub's Link relations when more pages exist. */
function sendPage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  items: readonly unknown[],
): void {
  const { perPage, page } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (items.length > perPage) {
    const pageUrl = (n: number): string => {
      const copy = new URL(url.pathname, baseUrlOf(req));
      for (const [key, value] of url.searchParams) copy.searchParams.set(key, value);
      copy.searchParams.set('page', String(n));
      copy.searchParams.set('per_page', String(perPage));
      return copy.toString();
    };
    const links: string[] = [];
    if (page < lastPage) links.push(`<${pageUrl(page + 1)}>; rel="next"`, `<${pageUrl(lastPage)}>; rel="last"`);
    if (page > 1) links.push(`<${pageUrl(1)}>; rel="first"`, `<${pageUrl(page - 1)}>; rel="prev"`);
    if (links.length) headers.link = links.join(', ');
  }
  sendJson(res, 200, slice, headers);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function createRepoRecord(input: {
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
}): Repo {
  const repo: Repo = {
    id: nextRepoId,
    owner: VIEWER.login,
    name: input.name,
    isPrivate: input.isPrivate,
    description: input.description,
    defaultBranch: input.defaultBranch,
    head: `refs/heads/${input.defaultBranch}`,
    refs: new Map(),
    createdAtSec: tick(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  repos.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

// ----------------------------------------------------------------------------------------------
// REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  // The API root keeps the starter's exact answer (and needs no token, as shipped).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (!authorized(req)) {
    unauthorized(res);
    return;
  }

  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, userJson());
    return;
  }

  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', forge: AGENT });
    return;
  }

  if (method === 'POST' && path === '/api/v3/user/repos') {
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '' || name.includes('/') || name === '.' || name === '..') {
      sendJson(res, 422, { message: 'Repository creation failed: name is invalid' });
      return;
    }
    if (findRepo(VIEWER.login, name)) {
      sendJson(res, 422, { message: 'Repository creation failed: already exists' });
      return;
    }
    const defaultBranch =
      typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main';
    const repo = createRepoRecord({
      name,
      isPrivate: body.private === true,
      description: typeof body.description === 'string' ? body.description : '',
      defaultBranch,
    });
    sendJson(res, 201, repoJson(repo));
    return;
  }

  if (method === 'GET' && path === '/api/v3/user/repos') {
    const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
    sendPage(req, res, url, mine.map(repoJson));
    return;
  }

  const segments = path.split('/').slice(1).map(decodeSegment);
  if (segments.some((segment) => segment === null)) {
    notFound(res);
    return;
  }
  const parts = segments as string[];
  if (parts[0] === 'api' && parts[1] === 'v3' && parts[2] === 'repos' && parts.length >= 5) {
    const owner = parts[3] as string;
    const name = parts[4] as string;
    // Another owner's repository is a 404 for this token, never a 403 (the suite checks this).
    const repo = owner.toLowerCase() === VIEWER.login ? findRepo(owner, name) : undefined;
    if (!repo) {
      notFound(res);
      return;
    }
    const tail = parts.slice(5);
    await handleRepoRoute(req, res, url, repo, tail);
    return;
  }

  notFound(res);
}

/** Every route under /api/v3/repos/{owner}/{repo}. */
async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  tail: readonly string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && !body.name.includes('/')) {
        const oldKey = repoKey(repo.owner, repo.name);
        (repo as { name: string }).name = body.name;
        repos.delete(oldKey);
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      if (typeof body.default_branch === 'string' && body.default_branch !== '') {
        repo.defaultBranch = body.default_branch;
        if (!repo.refs.has(repo.head)) repo.head = `refs/heads/${repo.defaultBranch}`;
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    notFound(res);
    return;
  }

  const head = tail[0] as string;

  if (head === 'contents') {
    await handleContents(req, res, url, repo, tail.slice(1).join('/'));
    return;
  }

  if (head === 'git') {
    await handleGitDatabase(req, res, repo, tail.slice(1));
    return;
  }

  if (head === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([ref, oid]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: peelToCommit(store, oid) ?? oid },
          protected: false,
        }));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && tail.length >= 2) {
      const branch = tail.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: peelToCommit(store, oid) ?? oid }, protected: false });
      return;
    }
    notFound(res);
    return;
  }

  if (head === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      const refParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = branchTip(repo, refParam) ?? branchTip(repo, repo.defaultBranch);
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const { perPage, page } = pageParams(url);
      const all = listCommits(tip);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, slice.map((oid) => commitJson(oid)).filter((entry) => entry !== null));
      return;
    }
    if (method === 'GET' && tail.length === 2 && OID_PATTERN.test(tail[1] as string)) {
      const commit = commitJson(tail[1] as string);
      if (!commit) {
        notFound(res);
        return;
      }
      sendJson(res, 200, commit);
      return;
    }
    notFound(res);
    return;
  }

  if (head === 'labels') {
    await handleLabels(req, res, repo, tail.slice(1));
    return;
  }

  if (head === 'issues') {
    await handleIssues(req, res, url, repo, tail.slice(1));
    return;
  }

  if (head === 'pulls') {
    await handlePulls(req, res, url, repo, tail.slice(1));
    return;
  }

  notFound(res);
}

// ----------------------------------------------------------------------------------------------
// Contents API

function contentFileJson(repo: Repo, path: string, blobOid: string): Record<string, unknown> {
  const object = store.get(blobOid);
  const data = object ? object.data : Buffer.alloc(0);
  const base = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: base,
    path,
    sha: blobOid,
    content: data.toString('base64'),
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
  };
}

/** The branch a contents call works on: the body's/query's branch, else the default branch. */
function contentsBranch(repo: Repo, named: string | null): string {
  return named !== null && named !== '' ? named : repo.defaultBranch;
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  rawPath: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = rawPath.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = branchTip(repo, ref);
    if (tip === null) {
      notFound(res);
      return;
    }
    const found = lookupPath(commitTreeOf(tip), path);
    if (found === null) {
      notFound(res);
      return;
    }
    if (found.kind === 'file') {
      sendJson(res, 200, contentFileJson(repo, path, found.oid));
      return;
    }
    const entries = treeEntriesOf(found.treeOid)
      .map((entry) => {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') {
          return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid, size: 0 };
        }
        const blob = store.get(entry.oid);
        return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob ? blob.data.length : 0 };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    sendJson(res, 200, entries);
    return;
  }

  if (method === 'PUT') {
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (path === '') {
      sendJson(res, 422, { message: 'Invalid request: no file path given' });
      return;
    }
    const message = asString(body.message);
    const encoded = typeof body.content === 'string' ? body.content.replace(/\s+/g, '') : '';
    let data: Buffer;
    try {
      data = Buffer.from(encoded, 'base64');
    } catch {
      sendJson(res, 422, { message: 'Invalid request: content is not base64' });
      return;
    }
    const branch = contentsBranch(repo, typeof body.branch === 'string' ? body.branch : null);
    const ref = `refs/heads/${branch}`;
    let tip = branchTip(repo, ref);
    // A write addressed at a branch that does not exist yet creates it, parented on the
    // default branch's tip (the suite's setup uses this when it cannot create the ref first).
    if (tip === null && branch !== repo.defaultBranch) {
      tip = branchTip(repo, `refs/heads/${repo.defaultBranch}`);
    }
    const tree = commitTreeOf(tip);
    const existing = lookupPath(tree, path);
    const existingFile = existing !== null && existing.kind === 'file' ? existing : null;
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    if (existingFile !== null) {
      if (givenSha === null) {
        sendJson(res, 422, { message: 'Invalid request: "sha" wasn\'t supplied' });
        return;
      }
      if (givenSha.toLowerCase() !== existingFile.oid.toLowerCase()) {
        sendJson(res, 409, { message: `${path} does not match ${givenSha}` });
        return;
      }
    }
    const blobOid = store.add('blob', data);
    const flat = flattenTree(tree);
    flat.set(path, { oid: blobOid, mode: existingFile?.mode ?? '100644' });
    const commitOid = makeCommit(unflattenTree(flat), tip === null ? [] : [tip], message);
    repo.refs.set(ref, commitOid);
    if (branch === repo.defaultBranch && repo.refs.get(repo.head) === undefined) repo.head = ref;
    sendJson(res, existingFile !== null ? 200 : 201, {
      content: contentFileJson(repo, path, blobOid),
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const branch = contentsBranch(repo, typeof body.branch === 'string' ? body.branch : null);
    const ref = `refs/heads/${branch}`;
    const tip = branchTip(repo, ref);
    const tree = commitTreeOf(tip);
    const existing = lookupPath(tree, path);
    if (existing === null || existing.kind !== 'file' || tip === null) {
      notFound(res);
      return;
    }
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    if (givenSha !== null && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      sendJson(res, 409, { message: `${path} does not match ${givenSha}` });
      return;
    }
    const flat = flattenTree(tree);
    flat.delete(path);
    const commitOid = makeCommit(unflattenTree(flat), [tip], asString(body.message));
    repo.refs.set(ref, commitOid);
    sendJson(res, 200, { content: null, commit: { sha: commitOid, message: asString(body.message) } });
    return;
  }

  notFound(res);
}

// ----------------------------------------------------------------------------------------------
// Git database API (/git/...)

function refJson(repo: Repo, ref: string): Record<string, unknown> {
  const oid = repo.refs.get(ref) as string;
  const object = store.get(oid);
  return { ref, node_id: `REF_${ref}`, object: { sha: oid, type: object ? object.type : 'commit' } };
}

async function handleGitDatabase(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: readonly string[],
): Promise<void> {
  const method = req.method ?? 'GET';
  const kind = tail[0] ?? '';

  if (kind === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/') || !OID_PATTERN.test(sha) || !store.has(sha)) {
        sendJson(res, 422, { message: 'Invalid request: ref or sha is not usable' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, refJson(repo, ref));
      return;
    }
    if (method === 'GET') {
      if (tail.length === 1) {
        const all = [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref));
        sendJson(res, 200, all);
        return;
      }
      const ref = `refs/${tail.slice(1).join('/')}`;
      if (repo.refs.has(ref)) {
        sendJson(res, 200, refJson(repo, ref));
        return;
      }
      const prefix = `${ref}/`;
      const under = [...repo.refs.keys()].filter((candidate) => candidate.startsWith(prefix)).sort();
      if (under.length > 0) {
        sendJson(res, 200, under.map((candidate) => refJson(repo, candidate)));
        return;
      }
      notFound(res);
      return;
    }
    if (method === 'DELETE' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      if (!repo.refs.has(ref)) {
        notFound(res);
        return;
      }
      repo.refs.delete(ref);
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === 'PATCH' && tail.length >= 2) {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const ref = `refs/${tail.slice(1).join('/')}`;
      const sha = asString(body.sha);
      if (!repo.refs.has(ref) || !OID_PATTERN.test(sha) || !store.has(sha)) {
        notFound(res);
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 200, refJson(repo, ref));
      return;
    }
    notFound(res);
    return;
  }

  if (kind === 'commits') {
    if (method === 'GET' && tail.length === 2) {
      const commit = commitJson(tail[1] as string);
      if (!commit) {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        sha: commit.sha,
        author: (commit.commit as Record<string, unknown>).author,
        committer: (commit.commit as Record<string, unknown>).committer,
        message: (commit.commit as Record<string, unknown>).message,
        tree: (commit.commit as Record<string, unknown>).tree,
        parents: commit.parents,
      });
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const tree = asString(body.tree);
      if (!OID_PATTERN.test(tree) || store.get(tree)?.type !== 'tree') {
        sendJson(res, 422, { message: 'Invalid request: tree is not usable' });
        return;
      }
      const parents = Array.isArray(body.parents)
        ? body.parents.filter((parent): parent is string => typeof parent === 'string' && OID_PATTERN.test(parent))
        : [];
      const oid = makeCommit(tree, parents, asString(body.message));
      const commit = commitJson(oid);
      sendJson(res, 201, {
        sha: oid,
        author: (commit?.commit as Record<string, unknown> | undefined)?.author,
        committer: (commit?.commit as Record<string, unknown> | undefined)?.committer,
        message: asString(body.message),
        tree: { sha: tree },
        parents: parents.map((parent) => ({ sha: parent })),
      });
      return;
    }
    notFound(res);
    return;
  }

  if (kind === 'trees') {
    if (method === 'GET' && tail.length === 2) {
      const object = store.get(tail[1] as string);
      if (!object || object.type !== 'tree') {
        notFound(res);
        return;
      }
      const recursive = req.url !== undefined && new URL(req.url, 'http://entry').searchParams.get('recursive') === '1';
      const treeList: Record<string, unknown>[] = [];
      const walk = (treeOid: string, prefix: string): void => {
        for (const entry of treeEntriesOf(treeOid)) {
          const entryPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          const isTree = entry.mode === '40000';
          const blob = isTree ? undefined : store.get(entry.oid);
          treeList.push({
            path: entryPath,
            mode: entry.mode,
            type: isTree ? 'tree' : 'blob',
            sha: entry.oid,
            ...(isTree ? {} : { size: blob ? blob.data.length : 0 }),
          });
          if (recursive && isTree) walk(entry.oid, entryPath);
        }
      };
      walk(tail[1] as string, '');
      sendJson(res, 200, { sha: tail[1], tree: treeList, truncated: false });
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const flat = new Map<string, FlatEntry>();
      const baseTree = typeof body.base_tree === 'string' ? body.base_tree : null;
      if (baseTree !== null && store.get(baseTree)?.type === 'tree') {
        for (const [path, entry] of flattenTree(baseTree)) flat.set(path, entry);
      }
      const entries = Array.isArray(body.tree) ? body.tree : [];
      for (const raw of entries) {
        if (raw === null || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        const path = asString(entry.path);
        if (path === '') continue;
        if (entry.sha === null) {
          flat.delete(path);
          continue;
        }
        let oid = asString(entry.sha);
        if (oid === '' && typeof entry.content === 'string') {
          oid = store.add('blob', Buffer.from(entry.content, 'utf8'));
        }
        if (!OID_PATTERN.test(oid)) continue;
        flat.set(path, { oid, mode: asString(entry.mode) || '100644' });
      }
      const treeOid = unflattenTree(flat);
      sendJson(res, 201, { sha: treeOid });
      return;
    }
    notFound(res);
    return;
  }

  if (kind === 'blobs') {
    if (method === 'GET' && tail.length === 2) {
      const object = store.get(tail[1] as string);
      if (!object || object.type !== 'blob') {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        sha: tail[1],
        node_id: `B_${tail[1]}`,
        size: object.data.length,
        content: object.data.toString('base64'),
        encoding: 'base64',
      });
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const content = asString(body.content);
      const data =
        body.encoding === 'base64' ? Buffer.from(content.replace(/\s+/g, ''), 'base64') : Buffer.from(content, 'utf8');
      const oid = store.add('blob', data);
      sendJson(res, 201, { sha: oid });
      return;
    }
    notFound(res);
    return;
  }

  if (kind === 'tags') {
    if (method === 'GET' && tail.length === 2) {
      const object = store.get(tail[1] as string);
      if (!object || object.type !== 'tag') {
        notFound(res);
        return;
      }
      const text = object.data.toString('utf8');
      const read = (key: string): string => {
        const line = text.split('\n').find((candidate) => candidate.startsWith(`${key} `));
        return line ? line.slice(key.length + 1) : '';
      };
      sendJson(res, 200, {
        sha: tail[1],
        node_id: `T_${tail[1]}`,
        tag: read('tag'),
        message: text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2).replace(/\n$/, '') : '',
        object: { sha: read('object'), type: read('type') },
        tagger: { name: VIEWER.name, email: VIEWER.email, date: iso(repo.createdAtSec) },
      });
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const tag = asString(body.tag);
      const object = asString(body.object);
      const type = asString(body.type) || 'commit';
      if (tag === '' || !OID_PATTERN.test(object) || !store.has(object)) {
        sendJson(res, 422, { message: 'Invalid request: tag or object is not usable' });
        return;
      }
      const at = tick();
      const data = Buffer.from(
        `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${VIEWER.name} <${VIEWER.email}> ${at} +0000\n\n${asString(body.message)}\n`,
        'utf8',
      );
      const oid = store.add('tag', data);
      sendJson(res, 201, { sha: oid, tag, message: asString(body.message), object: { sha: object, type } });
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// ----------------------------------------------------------------------------------------------
// Labels

async function handleLabels(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: readonly string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].sort((a, b) => a.id - b.id).map(labelJson));
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const name = asString(body.name);
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      if (repo.labels.has(name.toLowerCase())) {
        sendJson(res, 422, { message: 'Validation Failed: name has already been taken' });
        return;
      }
      const label: LabelRec = {
        id: nextLabelId,
        name,
        color: (asString(body.color) || 'ededed').replace(/^#/, '').toLowerCase(),
        description: asString(body.description),
      };
      nextLabelId += 1;
      repo.labels.set(name.toLowerCase(), label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    notFound(res);
    return;
  }
  const label = repo.labels.get((tail.join('/') as string).toLowerCase());
  if (method === 'GET') {
    if (!label) {
      notFound(res);
      return;
    }
    sendJson(res, 200, labelJson(label));
    return;
  }
  if (method === 'DELETE') {
    if (!label) {
      notFound(res);
      return;
    }
    repo.labels.delete(label.name.toLowerCase());
    res.writeHead(204);
    res.end();
    return;
  }
  notFound(res);
}

/** Validate label names against the repo's label set; answers 422 and returns null on a stranger. */
function checkedLabels(res: ServerResponse, repo: Repo, names: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const name of names) {
    const label = repo.labels.get(name.toLowerCase());
    if (!label) {
      sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
      return null;
    }
    out.push(label.name);
  }
  return out;
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.labels)) return [];
  const names: string[] = [];
  for (const entry of body.labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
      names.push((entry as Record<string, unknown>).name as string);
    }
  }
  return names;
}

// ----------------------------------------------------------------------------------------------
// Issues + comments

function createIssueRecord(
  repo: Repo,
  input: { title: string; body: string; labels: readonly string[] },
): IssueRec {
  const at = tick();
  const issue: IssueRec = {
    id: nextRecordId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    comments: [],
    createdAtSec: at,
    updatedAtSec: at,
    closedAtSec: null,
    seq: (orderSeq += 1),
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  tail: readonly string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const title = asString(body.title);
      if (title === '') {
        sendJson(res, 422, { message: 'Validation Failed: title is required' });
        return;
      }
      const labels = checkedLabels(res, repo, labelNamesOf(body));
      if (labels === null) return;
      const issue = createIssueRecord(repo, { title, body: asString(body.body), labels });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') list = list.filter((issue) => issue.state === 'open');
      const keyOf = (issue: IssueRec): number =>
        sort === 'updated' ? issue.updatedAtSec * 100_000 + issue.seq : issue.seq;
      list.sort((a, b) => keyOf(a) - keyOf(b));
      if (direction !== 'asc') list.reverse();
      sendPage(req, res, url, list.map((issue) => issueJson(repo, issue)));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) {
    notFound(res);
    return;
  }
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (tail.length === 2 && tail[1] === 'comments') {
    const host = issue ?? pull;
    if (!host) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...host.comments].sort((a, b) => a.id - b.id).map(commentJson));
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const at = tick();
      const comment: CommentRec = { id: nextCommentId, body: asString(body.body), createdAtSec: at, updatedAtSec: at };
      nextCommentId += 1;
      host.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
      return;
    }
    notFound(res);
    return;
  }

  if (tail.length === 1) {
    if (!issue) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = checkedLabels(res, repo, labelNamesOf(body));
        if (labels === null) return;
        issue.labels = labels;
      }
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state;
        issue.closedAtSec = body.state === 'closed' ? tick() : null;
      }
      issue.updatedAtSec = tick();
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// ----------------------------------------------------------------------------------------------
// Pull requests

type PullCreateResult =
  | { readonly ok: true; readonly pull: PullRec }
  | { readonly ok: false; readonly status: number; readonly message: string };

function createPullRecord(
  repo: Repo,
  input: { title: string; body: string; head: string; base: string },
): PullCreateResult {
  const head = input.head.includes(':') ? (input.head.split(':').pop() as string) : input.head;
  const base = input.base.includes(':') ? (input.base.split(':').pop() as string) : input.base;
  const headTip = branchTip(repo, `refs/heads/${head}`);
  if (headTip === null) return { ok: false, status: 422, message: `Validation Failed: head branch "${head}" does not exist` };
  const baseTip = branchTip(repo, `refs/heads/${base}`);
  if (baseTip === null) return { ok: false, status: 422, message: `Validation Failed: base branch "${base}" does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return { ok: false, status: 422, message: `Validation Failed: a pull request already exists for ${head} into ${base}` };
    }
  }
  const at = tick();
  const pull: PullRec = {
    id: nextRecordId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    comments: [],
    createdAtSec: at,
    updatedAtSec: at,
    closedAtSec: null,
    seq: (orderSeq += 1),
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { ok: true, pull };
}

/** The changed files of a pull request: merge-base tree versus head tree. */
function pullFiles(repo: Repo, pull: PullRec): FileChange[] {
  const baseTip = branchTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = branchTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBaseOf(baseTip, headTip) ?? baseTip;
  return diffTrees(commitTreeOf(base), commitTreeOf(headTip));
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  tail: readonly string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const result = createPullRecord(repo, {
        title: asString(body.title),
        body: asString(body.body),
        head: asString(body.head),
        base: asString(body.base),
      });
      if (!result.ok) {
        sendJson(res, result.status, { message: result.message });
        return;
      }
      sendJson(res, 201, pullJson(repo, result.pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.seq - b.seq);
      if (direction !== 'asc') list.reverse();
      sendPage(req, res, url, list.map((pull) => pullJson(repo, pull)));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) {
    notFound(res);
    return;
  }
  const pull = repo.pulls.get(number);

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) {
      notFound(res);
      return;
    }
    // The body decides nothing but its shape: a malformed body is still a 400.
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const outcome = mergePull(repo, pull);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      if (outcome.reason === 'not-open') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      notFound(res);
      return;
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'GET') {
    if (pull && pull.merged) {
      res.writeHead(204);
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  if (!pull) {
    notFound(res);
    return;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.closedAtSec = tick();
      }
      if (body.state === 'open' && pull.state === 'closed' && !pull.merged) {
        pull.state = 'open';
        pull.closedAtSec = null;
      }
      pull.updatedAtSec = tick();
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    notFound(res);
    return;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    sendJson(
      res,
      200,
      pullFiles(repo, pull).map((change) => ({
        sha: change.sha,
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      })),
    );
    return;
  }

  if (tail.length === 2 && tail[1] === 'commits' && method === 'GET') {
    const baseTip = branchTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headTip = branchTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
    const base = mergeBaseOf(baseTip, headTip);
    const baseSet = new Set(base === null ? [] : listCommits(base));
    const commits = listCommits(headTip).filter((oid) => !baseSet.has(oid));
    sendJson(res, 200, commits.map((oid) => commitJson(oid)).filter((entry) => entry !== null));
    return;
  }

  notFound(res);
}

// ----------------------------------------------------------------------------------------------
// Git smart HTTP

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function uploadCaps(repo: Repo): string {
  return [
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'deepen-relative',
    'object-format=sha1',
    `agent=${AGENT}`,
    `symref=HEAD:${repo.head}`,
  ].join(' ');
}

function receiveCaps(): string {
  return ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', 'object-format=sha1', `agent=${AGENT}`].join(
    ' ',
  );
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const protocolHeader = req.headers['git-protocol'];
  const wantsV2 =
    service === 'git-upload-pack' &&
    typeof protocolHeader === 'string' &&
    protocolHeader.split(':').includes('version=2');
  if (wantsV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ]);
    sendBytes(res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps();
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const lines: string[] = [];
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name) as string;
    lines.push(`${oid} ${name}`);
    if (name.startsWith('refs/tags/')) {
      const peeled = peelTag(store, oid);
      if (peeled && peeled !== oid) lines.push(`${peeled} ${name}^{}`);
    }
  }
  const headOid = repo.refs.get(repo.head);
  if (lines.length === 0 && headOid === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else if (headOid !== undefined) {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const line of lines) parts.push(pktLine(`${line}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

type Packet = ReturnType<typeof readPktPacket>['packet'];

/** Decode a whole pkt-line body (upload-pack requests carry nothing else). Throws when malformed. */
function decodeAll(body: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < body.length) {
    const { packet, end } = readPktPacket(body, offset);
    packets.push(packet);
    offset = end;
  }
  return packets;
}

function packetText(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

function handleLsRefs(res: ServerResponse, repo: Repo, args: readonly string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(repo.head);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${repo.head}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${repo.head}` : ''}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelTag(store, oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function emptyFetchArgs(): FetchArgs {
  return { wants: [], haves: [], clientShallow: new Set(), depth: null, deepenSince: null, deepenNot: [], done: false };
}

function absorbFetchArg(args: FetchArgs, line: string): void {
  if (line.startsWith('want ')) {
    const oid = line.slice(5).trim();
    if (OID_PATTERN.test(oid)) args.wants.push(oid);
  } else if (line.startsWith('have ')) {
    const oid = line.slice(5).trim();
    if (OID_PATTERN.test(oid)) args.haves.push(oid);
  } else if (line.startsWith('shallow ')) {
    const oid = line.slice(8).trim();
    if (OID_PATTERN.test(oid)) args.clientShallow.add(oid);
  } else if (line.startsWith('deepen ')) {
    const n = Number(line.slice(7).trim());
    if (Number.isFinite(n) && n > 0) args.depth = Math.floor(n);
  } else if (line.startsWith('deepen-since ')) {
    const n = Number(line.slice('deepen-since '.length).trim());
    if (Number.isFinite(n)) args.deepenSince = Math.floor(n);
  } else if (line.startsWith('deepen-not ')) {
    args.deepenNot.push(line.slice('deepen-not '.length).trim());
  } else if (line === 'done') {
    args.done = true;
  }
  // thin-pack, no-progress, ofs-delta, wait-for-done, filter, want-ref, side-band-*: accepted, ignored.
}

function planFor(repo: Repo, args: FetchArgs) {
  const deepenNotTips: string[] = [];
  for (const entry of args.deepenNot) {
    const oid = repo.refs.get(entry) ?? (OID_PATTERN.test(entry) ? entry : null);
    if (oid) deepenNotTips.push(oid);
  }
  return planFetch(store, {
    wants: args.wants,
    haves: args.haves,
    clientShallow: args.clientShallow,
    depth: args.depth,
    deepenSince: args.deepenSince,
    deepenNotTips,
  });
}

function acknowledgmentLines(args: FetchArgs): string[] {
  const common = args.haves.filter((oid) => store.has(oid));
  return common.length ? common.map((oid) => `ACK ${oid}\n`) : ['NAK\n'];
}

async function handleUploadPackV2(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let packets: Packet[];
  try {
    packets = decodeAll(body);
  } catch {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const first = packets[0];
  if (!first || first.kind !== 'data') {
    sendJson(res, 400, { message: 'Missing command' });
    return;
  }
  const command = packetText(first);
  let index = 1;
  while (index < packets.length && packets[index].kind === 'data') index += 1; // capability lines
  if (index < packets.length && packets[index].kind === 'delim') index += 1;
  const argLines: string[] = [];
  while (index < packets.length && packets[index].kind === 'data') {
    argLines.push(packetText(packets[index]));
    index += 1;
  }

  if (command === 'command=ls-refs') {
    handleLsRefs(res, repo, argLines);
    return;
  }
  if (command !== 'command=fetch') {
    sendJson(res, 400, { message: `Unsupported command ${command}` });
    return;
  }
  const args = emptyFetchArgs();
  for (const line of argLines) absorbFetchArg(args, line);

  if (!args.done) {
    // A negotiation round (wait-for-done). With no common have the round is acknowledgments only
    // and the client offers more haves. With a common have the server is `ready`: the packfile
    // sections follow in this same response — git refuses a ready that is not followed by a pack.
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    for (const line of acknowledgmentLines(args)) parts.push(pktLine(line));
    if (!args.haves.some((oid) => store.has(oid))) {
      parts.push(pktFlush());
      sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
    appendPackSections(parts, repo, args);
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  // With `done` the negotiation is already settled (the client worked out the common bases
  // itself): git expects shallow-info / packfile first, and an acknowledgments section here —
  // with or without haves — is a protocol error ("expected 'packfile', received 'acknowledgments'").
  const parts: Buffer[] = [];
  appendPackSections(parts, repo, args);
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** Append the shallow-info (when the boundary moves) and packfile sections of a v2 fetch reply. */
function appendPackSections(parts: Buffer[], repo: Repo, args: FetchArgs): void {
  const plan = planFor(repo, args);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(plan.objects), 1));
  parts.push(pktFlush());
}

async function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let packets: Packet[];
  try {
    packets = decodeAll(body);
  } catch {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const args = emptyFetchArgs();
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packetText(packet);
    if (line.startsWith('want ')) {
      // The first want line carries the capability list after the oid.
      const oid = line.slice(5).split(' ')[0];
      if (OID_PATTERN.test(oid)) args.wants.push(oid);
    } else {
      absorbFetchArg(args, line);
    }
  }
  const hasShallowArgs =
    args.depth !== null || args.deepenSince !== null || args.deepenNot.length > 0 || args.clientShallow.size > 0;
  if (!args.done) {
    // An early round: over HTTP the client reads only this round's answer before sending more, so
    // the pack must not be sent yet — an unread remainder poisons the follow-up request. A shallow
    // fetch's first round (wants, no haves) reads the shallow section; a round carrying haves
    // reads acknowledgment lines.
    const parts: Buffer[] = [];
    if (args.wants.length > 0 && args.haves.length === 0 && hasShallowArgs) {
      const plan = planFor(repo, args);
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    } else if (args.haves.length > 0) {
      for (const line of acknowledgmentLines(args)) parts.push(pktLine(line));
    }
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  const plan = planFor(repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  // The shallow block is its own section: in a shallow fetch it is always present (possibly
  // empty) and flush-terminated before the NAK.
  if (plan.shallow.length || plan.unshallow.length || hasShallowArgs) parts.push(pktFlush());
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(writePack(plan.objects), 1));
  parts.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface RefCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function applyRefUpdate(repo: Repo, command: RefCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) {
    return { ok: false, reason: 'invalid ref' };
  }
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return { ok: false, reason: 'reference does not exist' };
    if (oldOid !== current) return { ok: false, reason: 'stale info' };
    if (ref === repo.head) return { ok: false, reason: 'deletion of the current branch prohibited' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const object: GitObject | undefined = store.get(newOid);
  if (!object) return { ok: false, reason: 'unable to read object' };
  if (oldOid !== current) {
    return { ok: false, reason: current === ZERO_OID ? 'stale info' : 'reference already exists' };
  }
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return { ok: false, reason: 'not a commit' };
    if (current !== ZERO_OID && !isAncestor(store, current, newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const commands: RefCommand[] = [];
  const clientCaps = new Set<string>();
  let offset = 0;
  let first = true;
  try {
    for (;;) {
      const { packet, end } = readPktPacket(body, offset);
      offset = end;
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          for (const cap of line.slice(nul + 1).split(' ')) if (cap) clientCaps.add(cap);
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length >= 3 && OID_PATTERN.test(parts[0]) && OID_PATTERN.test(parts[1])) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
    }
  } catch {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const packBytes = body.subarray(offset);

  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const read = await readPack(packBytes, (oid) => store.get(oid));
      for (const [oid, object] of read.objects) store.put(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    unpackOk = false;
    unpackError = 'no pack sent for a ref update';
  }

  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok\n');
  else reportLines.push(`unpack error: ${unpackError.replace(/[\r\n]+/g, ' ').slice(0, 200)}\n`);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const result = applyRefUpdate(repo, command);
    reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
  }
  // The report stream is pkt-lined and flush-terminated in its own right; the sideband wraps it.
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
  const responseBody = clientCaps.has('side-band-64k')
    ? Buffer.concat([...sidebandPackets(inner, 1), pktFlush()])
    : inner;
  sendBytes(res, 200, responseBody, 'application/x-git-receive-pack-result');
}

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  match: RegExpExecArray,
): Promise<void> {
  const method = req.method ?? 'GET';
  let owner = match[1];
  let name = match[2];
  try {
    owner = decodeURIComponent(owner);
    name = decodeURIComponent(name);
  } catch {
    notFound(res);
    return;
  }
  const endpoint = match[3];
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  const repo = owner.toLowerCase() === VIEWER.login ? findRepo(owner, name) : undefined;
  if (!repo) {
    notFound(res);
    return;
  }
  if (endpoint === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      notFound(res);
      return;
    }
    handleInfoRefs(req, res, repo, service);
    return;
  }
  if (endpoint === 'git-upload-pack' && method === 'POST') {
    const protocolHeader = req.headers['git-protocol'];
    const v2 = typeof protocolHeader === 'string' && protocolHeader.split(':').includes('version=2');
    if (v2) await handleUploadPackV2(req, res, repo);
    else await handleUploadPackV0(req, res, repo);
    return;
  }
  if (endpoint === 'git-receive-pack' && method === 'POST') {
    await handleReceivePack(req, res, repo);
    return;
  }
  notFound(res);
}

// ----------------------------------------------------------------------------------------------
// GraphQL v4 (/api/graphql)
//
// A compact executor for the documents gh and github-mcp-server send: operations with
// variables, aliases, inline and named fragments, input objects, enum lists, Relay `node(id:)`,
// cursor connections, the mutations the suite drives, batching (a JSON array of operations),
// and the __type introspection probes. An unknown field is a 200 with an `errors` array naming
// the field; an unknown repository is `data.repository = null` with no errors.

type GqlValue =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly GqlValue[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, GqlValue>> };

interface GqlField {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Readonly<Record<string, GqlValue>>;
  readonly selections: readonly GqlSelection[];
}

type GqlSelection =
  | GqlField
  | { readonly kind: 'inline'; readonly typeCondition: string | null; readonly selections: readonly GqlSelection[] }
  | { readonly kind: 'spread'; readonly name: string };

interface GqlOperation {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: readonly GqlSelection[];
}

interface GqlDocument {
  readonly operations: readonly GqlOperation[];
  readonly fragments: Readonly<Record<string, { readonly typeCondition: string; readonly selections: readonly GqlSelection[] }>>;
}

function gqlTokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/[\s,]/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$!@=|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push(JSON.stringify(source.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          out += source[j] + (source[j + 1] ?? '');
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const rest = source.slice(i);
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (nameMatch) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (numMatch) {
      tokens.push(numMatch[0]);
      i += numMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: readonly string[];
  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
  }

  private peek(): string | null {
    return this.pos < this.tokens.length ? (this.tokens[this.pos] as string) : null;
  }

  private next(): string {
    const token = this.peek();
    if (token === null) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  private skipType(): void {
    // A type reference: Name, [Type], with optional trailing !.
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments: Record<string, { typeCondition: string; selections: readonly GqlSelection[] }> = {};
    while (this.peek() !== null) {
      const head = this.peek() as string;
      if (head === '{') {
        operations.push({ operation: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | null = null;
        const after = this.peek();
        if (after !== null && after !== '(' && after !== '{' && after !== '@') name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          operation: head === 'mutation' ? 'mutation' : 'query',
          name,
          selections: this.parseSelectionSet(),
        });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments[fragName] = { typeCondition, selections: this.parseSelectionSet() };
      } else if (head === 'schema' || head === 'scalar' || head === 'type' || head === 'interface' || head === 'union' || head === 'enum' || head === 'input' || head === 'extend' || head === 'directive') {
        // Type-system definitions are not part of the documents the suite sends; skip a block.
        while (this.peek() !== null && this.peek() !== '{') this.next();
        if (this.peek() === '{') {
          let depth = 0;
          do {
            const token = this.next();
            if (token === '{') depth += 1;
            else if (token === '}') depth -= 1;
          } while (depth > 0 && this.peek() !== null);
        }
      } else {
        throw new Error(`unexpected token ${head} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.skipType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          this.next(); // argument name
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, GqlValue> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      this.skipDirectives();
      const sub = this.peek() === '{' ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    this.expect('}');
    return selections;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields[fieldName] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) {
      try {
        return { kind: 'string', value: JSON.parse(token) as string };
      } catch {
        return { kind: 'string', value: token.slice(1, -1) };
      }
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function gqlResolve(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable': {
      const resolved = variables[value.name];
      return resolved === undefined ? null : resolved;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => gqlResolve(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = gqlResolve(entry, variables);
      return out;
    }
  }
}

// Global (Relay) ids: opaque base64, stable across reads, never the plain database id.
function globalId(type: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([type, ...parts].join(':'), 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const [type, ...parts] = decoded.split(':');
    if (type === undefined || type === '') return null;
    return { type, parts };
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => globalId('Repository', repo.id);
const issueGlobalId = (repo: Repo, issue: IssueRec): string => globalId('Issue', repo.id, issue.number);
const pullGlobalId = (repo: Repo, pull: PullRec): string => globalId('PullRequest', repo.id, pull.number);
const commentGlobalId = (comment: CommentRec): string => globalId('IssueComment', comment.id);

function findRepoById(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

/** Typed values the executor completes selection sets over. */
interface GqlObject {
  readonly __typename: string;
  readonly repo?: Repo;
  readonly issue?: IssueRec;
  readonly pull?: PullRec;
  readonly comment?: CommentRec;
  readonly label?: LabelRec;
  readonly typeName?: string;
  readonly connection?: {
    readonly items: readonly GqlObject[];
    readonly totalCount: number;
    readonly cursorOf: (item: GqlObject) => string;
    readonly findIndex: (cursor: string) => number;
    /** The first/after arguments carried by the field that produced this connection. */
    readonly pageArgs?: Readonly<Record<string, unknown>>;
  };
  readonly payload?: Readonly<Record<string, unknown>>;
}

const userObject = (): GqlObject => ({ __typename: 'User' });
const repoObject = (repo: Repo): GqlObject => ({ __typename: 'Repository', repo });
const issueObject = (repo: Repo, issue: IssueRec): GqlObject => ({ __typename: 'Issue', repo, issue });
const pullObject = (repo: Repo, pull: PullRec): GqlObject => ({ __typename: 'PullRequest', repo, pull });
const commentObject = (repo: Repo, comment: CommentRec): GqlObject => ({ __typename: 'IssueComment', repo, comment });

const GQL_TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: [
    'createIssue',
    'closeIssue',
    'reopenIssue',
    'updateIssue',
    'addComment',
    'createPullRequest',
    'mergePullRequest',
    'updatePullRequest',
  ],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'hasPullRequestsEnabled',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
    'description',
    'isPrivate',
    'isFork',
    'url',
    'createdAt',
    'updatedAt',
    'pushedAt',
    'stargazerCount',
    'forkCount',
    'labels',
    'refs',
    'ref',
    'object',
  ],
  Issue: [
    'id',
    'databaseId',
    'number',
    'title',
    'state',
    'body',
    'author',
    'createdAt',
    'updatedAt',
    'closedAt',
    'url',
    'labels',
    'comments',
    'repository',
    'reactions',
  ],
  PullRequest: [
    'id',
    'databaseId',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'mergeable',
    'headRefName',
    'baseRefName',
    'headRefOid',
    'baseRefOid',
    'author',
    'createdAt',
    'updatedAt',
    'mergedAt',
    'closedAt',
    'url',
    'files',
    'additions',
    'deletions',
    'changedFiles',
    'repository',
    'mergeCommit',
    'commits',
    'comments',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'id', 'message', 'messageHeadline', 'committedDate', 'authoredDate', 'tree', 'parents'],
  Tree: ['oid', 'id', 'entries'],
  Blob: ['oid', 'id', 'text', 'byteSize', 'isBinary'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  UpdateIssuePayload: ['issue', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  UpdatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
};

const GQL_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  State: ['OPEN', 'CLOSED'],
};

const GQL_KINDS: Readonly<Record<string, string>> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  PullRequestOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  String: 'SCALAR',
  Int: 'SCALAR',
  Boolean: 'SCALAR',
  ID: 'SCALAR',
  URI: 'SCALAR',
  DateTime: 'SCALAR',
  GitObjectID: 'SCALAR',
};

interface GqlExec {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: GqlDocument['fragments'];
  readonly errors: { message: string }[];
}

function gqlArgs(field: GqlField, exec: GqlExec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = gqlResolve(value, exec.variables);
  return out;
}

function connectionObject(
  typename: string,
  items: readonly GqlObject[],
  cursorKey: (item: GqlObject) => string,
  pageArgs?: Readonly<Record<string, unknown>>,
): GqlObject {
  return {
    __typename: typename,
    connection: {
      items,
      totalCount: items.length,
      pageArgs,
      cursorOf: (item) => Buffer.from(`cursor:${cursorKey(item)}`, 'utf8').toString('base64'),
      findIndex: (cursor) => {
        let key: string;
        try {
          key = Buffer.from(cursor, 'base64').toString('utf8').replace(/^cursor:/, '');
        } catch {
          return -1;
        }
        return items.findIndex((item) => cursorKey(item) === key);
      },
    },
  };
}

/** Slice a connection by first/after, GitHub-style (args from the producing field win). */
function pageOf(
  connection: NonNullable<GqlObject['connection']>,
  args: Record<string, unknown>,
): { page: GqlObject[]; hasNextPage: boolean } {
  const effective = { ...(connection.pageArgs ?? {}), ...args };
  let start = 0;
  const after = typeof effective.after === 'string' ? effective.after : null;
  if (after !== null) {
    const index = connection.findIndex(after);
    if (index >= 0) start = index + 1;
  }
  const first = typeof effective.first === 'number' && Number.isFinite(effective.first) ? Math.max(0, Math.floor(effective.first)) : 100;
  const page = connection.items.slice(start, start + first);
  return { page, hasNextPage: start + page.length < connection.items.length };
}

function issueStateGraphql(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGraphql(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveObjectField(obj: GqlObject, field: GqlField, exec: GqlExec): unknown {
  const args = gqlArgs(field, exec);
  const type = obj.__typename;

  if (type === 'User') {
    switch (field.name) {
      case 'login':
        return VIEWER.login;
      case 'id':
        return globalId('User', VIEWER.id);
      case 'databaseId':
        return VIEWER.id;
      case 'name':
        return VIEWER.name;
      case 'email':
        return VIEWER.email;
      case 'url':
        return `https://forge.invalid/${VIEWER.login}`;
      case 'avatarUrl':
        return 'https://forge.invalid/avatar.png';
      case 'isViewer':
        return true;
      case 'createdAt':
      case 'updatedAt':
        return iso(EPOCH_SEC);
      default:
        break;
    }
  }

  if (type === 'Repository' && obj.repo) {
    const repo = obj.repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return userObject();
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.head);
        return {
          __typename: 'Ref',
          payload: { name: repo.defaultBranch, oid: tip },
        } as GqlObject;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'hasPullRequestsEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'isFork':
        return false;
      case 'url':
        return `https://forge.invalid/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
      case 'pushedAt':
        return iso(repo.createdAtSec);
      case 'stargazerCount':
      case 'forkCount':
        return 0;
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : Number.NaN;
        const issue = repo.issues.get(number);
        return issue ? issueObject(repo, issue) : null;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? args.states.map((entry) => String(entry).toLowerCase()) : null;
        if (states !== null) list = list.filter((issue) => states.includes(issue.state));
        const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
        const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
        const fieldName = orderBy?.field ?? 'CREATED_AT';
        const keyOf = (issue: IssueRec): [number, number] =>
          fieldName === 'UPDATED_AT'
            ? [issue.updatedAtSec, issue.number]
            : fieldName === 'COMMENTS'
              ? [issue.comments.length, issue.number]
              : [issue.seq, issue.number];
        list.sort((a, b) => {
          const [ak, an] = keyOf(a);
          const [bk, bn] = keyOf(b);
          const cmp = ak !== bk ? ak - bk : an - bn;
          return direction === 'DESC' ? -cmp : cmp;
        });
        return connectionObject(
          'IssueConnection',
          list.map((issue) => issueObject(repo, issue)),
          (item) => `issue:${item.issue?.number}`,
          args,
        );
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : Number.NaN;
        const pull = repo.pulls.get(number);
        return pull ? pullObject(repo, pull) : null;
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? args.states.map((entry) => String(entry)) : null;
        if (states !== null) {
          list = list.filter((pull) => states.includes(pullStateGraphql(pull)));
        }
        const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
        list.sort((a, b) => a.seq - b.seq);
        if (orderBy?.direction === 'DESC') list.reverse();
        return connectionObject(
          'PullRequestConnection',
          list.map((pull) => pullObject(repo, pull)),
          (item) => `pull:${item.pull?.number}`,
          args,
        );
      }
      case 'labels': {
        const labels = [...repo.labels.values()].sort((a, b) => a.id - b.id);
        return connectionObject(
          'LabelConnection',
          labels.map((label) => ({ __typename: 'Label', repo, label }) as GqlObject),
          (item) => `label:${item.label?.name}`,
          args,
        );
      }
      case 'ref': {
        const name = typeof args.qualifiedName === 'string' ? args.qualifiedName : '';
        const oid = resolveRef(repo, name);
        if (oid === null) return null;
        return { __typename: 'Ref', payload: { name: name.replace(/^refs\/(heads|tags)\//, ''), oid } } as GqlObject;
      }
      case 'object': {
        const oid = typeof args.oid === 'string' ? args.oid : typeof args.expression === 'string' ? resolveRef(repo, args.expression) : null;
        if (oid === null || !OID_PATTERN.test(oid)) return null;
        const object = store.get(oid);
        if (!object) return null;
        const typename = object.type === 'commit' ? 'Commit' : object.type === 'tree' ? 'Tree' : 'Blob';
        return { __typename: typename, payload: { oid } } as GqlObject;
      }
      default:
        break;
    }
  }

  if (type === 'Issue' && obj.issue && obj.repo) {
    const issue = obj.issue;
    const repo = obj.repo;
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueStateGraphql(issue);
      case 'body':
        return issue.body;
      case 'author':
        return userObject();
      case 'createdAt':
        return iso(issue.createdAtSec);
      case 'updatedAt':
        return iso(issue.updatedAtSec);
      case 'closedAt':
        return issue.closedAtSec === null ? null : iso(issue.closedAtSec);
      case 'url':
        return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'repository':
        return repoObject(repo);
      case 'labels':
        return connectionObject(
          'LabelConnection',
          issue.labels
            .map((name) => repo.labels.get(name.toLowerCase()))
            .filter((label): label is LabelRec => label !== undefined)
            .map((label) => ({ __typename: 'Label', repo, label }) as GqlObject),
          (item) => `label:${item.label?.name}`,
          args,
        );
      case 'comments':
        return connectionObject(
          'IssueCommentConnection',
          issue.comments.map((comment) => commentObject(repo, comment)),
          (item) => `comment:${item.comment?.id}`,
          args,
        );
      default:
        break;
    }
  }

  if (type === 'PullRequest' && obj.pull && obj.repo) {
    const pull = obj.pull;
    const repo = obj.repo;
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullStateGraphql(pull);
      case 'merged':
        return pull.merged;
      case 'mergeable':
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return branchTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
      case 'baseRefOid':
        return branchTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      case 'author':
        return userObject();
      case 'createdAt':
        return iso(pull.createdAtSec);
      case 'updatedAt':
        return iso(pull.updatedAtSec);
      case 'mergedAt':
        return pull.mergedAtSec === null ? null : iso(pull.mergedAtSec);
      case 'closedAt':
        return pull.closedAtSec === null ? null : iso(pull.closedAtSec);
      case 'url':
        return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'repository':
        return repoObject(repo);
      case 'files': {
        const files = pullFiles(repo, pull);
        return connectionObject(
          'PullRequestChangedFileConnection',
          files.map(
            (change) =>
              ({
                __typename: 'PullRequestChangedFile',
                payload: {
                  path: change.filename,
                  additions: change.additions,
                  deletions: change.deletions,
                  changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
                },
              }) as GqlObject,
          ),
          (item) => `file:${(item.payload as Record<string, unknown>).path}`,
          args,
        );
      }
      case 'additions':
        return pullFiles(repo, pull).reduce((sum, change) => sum + change.additions, 0);
      case 'deletions':
        return pullFiles(repo, pull).reduce((sum, change) => sum + change.deletions, 0);
      case 'changedFiles':
        return pullFiles(repo, pull).length;
      case 'mergeCommit':
        return pull.mergeCommitSha === null
          ? null
          : ({ __typename: 'Commit', payload: { oid: pull.mergeCommitSha } } as GqlObject);
      case 'comments':
        return connectionObject(
          'IssueCommentConnection',
          pull.comments.map((comment) => commentObject(repo, comment)),
          (item) => `comment:${item.comment?.id}`,
          args,
        );
      case 'commits': {
        const baseTip = branchTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        const headTip = branchTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
        const base = mergeBaseOf(baseTip, headTip);
        const baseSet = new Set(base === null ? [] : listCommits(base));
        const commits = listCommits(headTip).filter((oid) => !baseSet.has(oid));
        return connectionObject(
          'PullRequestCommitConnection',
          commits.map((oid) => ({ __typename: 'Commit', payload: { oid } }) as GqlObject),
          (item) => `commit:${(item.payload as Record<string, unknown>).oid}`,
          args,
        );
      }
      default:
        break;
    }
  }

  if (type === 'IssueComment' && obj.comment) {
    const comment = obj.comment;
    switch (field.name) {
      case 'id':
        return commentGlobalId(comment);
      case 'databaseId':
        return comment.id;
      case 'body':
        return comment.body;
      case 'author':
        return userObject();
      case 'createdAt':
        return iso(comment.createdAtSec);
      case 'updatedAt':
        return iso(comment.updatedAtSec);
      case 'url':
        return `https://forge.invalid/#issuecomment-${comment.id}`;
      default:
        break;
    }
  }

  if (type === 'Label' && obj.label) {
    switch (field.name) {
      case 'id':
        return globalId('Label', obj.label.id);
      case 'name':
        return obj.label.name;
      case 'color':
        return obj.label.color;
      case 'description':
        return obj.label.description;
      default:
        break;
    }
  }

  if (type === 'Ref') {
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'name':
        return payload.name ?? '';
      case 'prefix':
        return 'refs/heads/';
      case 'target': {
        const oid = typeof payload.oid === 'string' ? payload.oid : null;
        if (oid === null) return null;
        const commit = peelToCommit(store, oid) ?? oid;
        return { __typename: 'Commit', payload: { oid: commit } } as GqlObject;
      }
      default:
        break;
    }
  }

  if (type === 'Commit' || type === 'Tree' || type === 'Blob') {
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    const oid = typeof payload.oid === 'string' ? payload.oid : '';
    const object = store.get(oid);
    switch (field.name) {
      case 'oid':
      case 'id':
        return oid;
      case 'message': {
        if (!object || object.type !== 'commit') return null;
        return commitView(object.data).message;
      }
      case 'messageHeadline': {
        if (!object || object.type !== 'commit') return null;
        return commitView(object.data).message.split('\n')[0] ?? '';
      }
      case 'committedDate':
      case 'authoredDate': {
        if (!object || object.type !== 'commit') return null;
        return iso(commitView(object.data).committerSec || EPOCH_SEC);
      }
      case 'tree': {
        if (!object || object.type !== 'commit') return null;
        return { __typename: 'Tree', payload: { oid: commitView(object.data).tree } } as GqlObject;
      }
      case 'parents': {
        if (!object || object.type !== 'commit') return null;
        return connectionObject(
          'CommitConnection',
          commitView(object.data).parents.map((parent) => ({ __typename: 'Commit', payload: { oid: parent } }) as GqlObject),
          (item) => `commit:${(item.payload as Record<string, unknown>).oid}`,
          args,
        );
      }
      case 'entries': {
        if (!object || object.type !== 'tree') return null;
        return treeEntriesOf(oid).map((entry) => ({
          __typename: 'TreeEntry',
          payload: { name: entry.name, path: entry.name, oid: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob', mode: Number(entry.mode) },
        })) as unknown as GqlObject[];
      }
      case 'text': {
        if (!object || object.type !== 'blob') return null;
        return object.data.toString('utf8');
      }
      case 'byteSize': {
        if (!object) return null;
        return object.data.length;
      }
      case 'isBinary':
        return false;
      default:
        break;
    }
  }

  if (type === 'PullRequestChangedFile' || type === 'TreeEntry') {
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    const value = payload[field.name];
    return value === undefined ? null : value;
  }

  if (obj.connection && (type.endsWith('Connection'))) {
    const connection = obj.connection;
    switch (field.name) {
      case 'totalCount':
        return connection.totalCount;
      case 'nodes':
        return pageOf(connection, args).page;
      case 'edges':
        return pageOf(connection, args).page.map((item) => ({
          __typename: type.replace('Connection', 'Edge'),
          payload: { nodeRaw: item, cursor: connection.cursorOf(item) },
        })) as unknown as GqlObject[];
      case 'pageInfo': {
        const { page, hasNextPage } = pageOf(connection, args);
        return {
          __typename: 'PageInfo',
          payload: {
            hasNextPage,
            hasPreviousPage: false,
            startCursor: page.length ? connection.cursorOf(page[0] as GqlObject) : null,
            endCursor: page.length ? connection.cursorOf(page[page.length - 1] as GqlObject) : null,
          },
        } as GqlObject;
      }
      default:
        break;
    }
  }

  if (type === 'PageInfo') {
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    const value = payload[field.name];
    return value === undefined ? null : value;
  }

  if (type.endsWith('Edge')) {
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    if (field.name === 'node') return (payload.nodeRaw as GqlObject) ?? null;
    if (field.name === 'cursor') return typeof payload.cursor === 'string' ? payload.cursor : '';
  }

  if (type.endsWith('Payload')) {
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    if (field.name === 'clientMutationId') return typeof payload.clientMutationId === 'string' ? payload.clientMutationId : null;
    const value = payload[field.name];
    return value === undefined ? null : value;
  }

  if (type === '__Type') {
    const name = obj.typeName ?? '';
    switch (field.name) {
      case 'name':
        return name;
      case 'kind':
        return GQL_KINDS[name] ?? (GQL_TYPE_FIELDS[name] ? 'OBJECT' : 'OBJECT');
      case 'description':
        return null;
      case 'fields': {
        const fields = GQL_TYPE_FIELDS[name];
        if (!fields) return null;
        return fields.map((fieldName) => ({ __typename: '__Field', payload: { name: fieldName } })) as unknown as GqlObject[];
      }
      case 'enumValues': {
        const values = GQL_ENUM_VALUES[name];
        if (!values) return null;
        return values.map((valueName) => ({ __typename: '__EnumValue', payload: { name: valueName } })) as unknown as GqlObject[];
      }
      case 'possibleTypes':
      case 'inputFields':
        return null;
      case 'ofType':
        return null;
      default:
        break;
    }
  }

  if (type === '__Field' || type === '__EnumValue') {
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'name':
        return typeof payload.name === 'string' ? payload.name : '';
      case 'description':
        return null;
      case 'isDeprecated':
        return false;
      case 'deprecationReason':
        return null;
      case 'args':
        return [];
      case 'type':
        return { __typename: '__Type', typeName: 'String' } as GqlObject;
      default:
        break;
    }
  }

  if (type === '__Schema') {
    switch (field.name) {
      case 'queryType':
        return { __typename: '__Type', typeName: 'Query' } as GqlObject;
      case 'mutationType':
        return { __typename: '__Type', typeName: 'Mutation' } as GqlObject;
      case 'subscriptionType':
        return null;
      case 'types':
        return [...Object.keys(GQL_TYPE_FIELDS), ...Object.keys(GQL_ENUM_VALUES)].map(
          (name) => ({ __typename: '__Type', typeName: name }) as GqlObject,
        );
      case 'directives':
        return [];
      default:
        break;
    }
  }

  exec.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
  return null;
}

function gqlComplete(value: unknown, selections: readonly GqlSelection[], exec: GqlExec): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => gqlComplete(entry, selections, exec));
  if (typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>)) {
    const obj = value as GqlObject;
    if (selections.length === 0) return { __typename: obj.__typename };
    const out: Record<string, unknown> = {};
    const walk = (sels: readonly GqlSelection[]): void => {
      for (const selection of sels) {
        if (selection.kind === 'inline') {
          if (selection.typeCondition === null || selection.typeCondition === obj.__typename) walk(selection.selections);
          continue;
        }
        if (selection.kind === 'spread') {
          const fragment = exec.fragments[selection.name];
          if (fragment && fragment.typeCondition === obj.__typename) walk(fragment.selections);
          continue;
        }
        const key = selection.alias ?? selection.name;
        if (selection.name === '__typename') {
          out[key] = obj.__typename;
          continue;
        }
        const resolved = resolveObjectField(obj, selection, exec);
        out[key] = gqlComplete(resolved, selection.selections, exec);
      }
    };
    walk(selections);
    return out;
  }
  return value;
}

function gqlFindByGlobalId(id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = findRepoById(Number(parsed.parts[0]));
    return repo ? repoObject(repo) : null;
  }
  if (parsed.type === 'Issue') {
    const repo = findRepoById(Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    return repo && issue ? issueObject(repo, issue) : null;
  }
  if (parsed.type === 'PullRequest') {
    const repo = findRepoById(Number(parsed.parts[0]));
    const pull = repo?.pulls.get(Number(parsed.parts[1]));
    return repo && pull ? pullObject(repo, pull) : null;
  }
  if (parsed.type === 'User') return userObject();
  if (parsed.type === 'IssueComment') {
    const commentId = Number(parsed.parts[0]);
    for (const repo of repos.values()) {
      for (const issue of repo.issues.values()) {
        const comment = issue.comments.find((candidate) => candidate.id === commentId);
        if (comment) return commentObject(repo, comment);
      }
      for (const pull of repo.pulls.values()) {
        const comment = pull.comments.find((candidate) => candidate.id === commentId);
        if (comment) return commentObject(repo, comment);
      }
    }
    return null;
  }
  return null;
}

function gqlMutation(field: GqlField, exec: GqlExec): unknown {
  const args = gqlArgs(field, exec);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  const payloadOf = (typename: string, extra: Record<string, unknown>): GqlObject =>
    ({ __typename: typename, payload: { ...extra, clientMutationId } }) as GqlObject;

  switch (field.name) {
    case 'createIssue': {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.type === 'Repository' ? findRepoById(Number(parsed.parts[0])) : undefined;
      if (!repo) {
        exec.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return null;
      }
      const labelNames = Array.isArray(input.labelIds)
        ? []
        : [];
      void labelNames;
      const issue = createIssueRecord(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return payloadOf('CreateIssuePayload', { issue: issueObject(repo, issue) });
    }
    case 'closeIssue':
    case 'reopenIssue': {
      const target = typeof input.issueId === 'string' ? gqlFindByGlobalId(input.issueId) : null;
      if (!target || target.__typename !== 'Issue' || !target.issue || !target.repo) {
        exec.errors.push({ message: 'Could not resolve the issue' });
        return null;
      }
      const closing = field.name === 'closeIssue';
      target.issue.state = closing ? 'closed' : 'open';
      target.issue.closedAtSec = closing ? tick() : null;
      target.issue.updatedAtSec = tick();
      return payloadOf(closing ? 'CloseIssuePayload' : 'ReopenIssuePayload', { issue: target });
    }
    case 'updateIssue': {
      const target = typeof input.id === 'string' ? gqlFindByGlobalId(input.id) : null;
      if (!target || target.__typename !== 'Issue' || !target.issue || !target.repo) {
        exec.errors.push({ message: 'Could not resolve the issue' });
        return null;
      }
      if (typeof input.title === 'string') target.issue.title = input.title;
      if (typeof input.body === 'string') target.issue.body = input.body;
      if (input.state === 'CLOSED' || input.state === 'OPEN') {
        target.issue.state = input.state === 'CLOSED' ? 'closed' : 'open';
        target.issue.closedAtSec = input.state === 'CLOSED' ? tick() : null;
      }
      target.issue.updatedAtSec = tick();
      return payloadOf('UpdateIssuePayload', { issue: target });
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? gqlFindByGlobalId(input.subjectId) : null;
      if (!target || (target.__typename !== 'Issue' && target.__typename !== 'PullRequest')) {
        exec.errors.push({ message: 'Could not resolve the subject for addComment' });
        return null;
      }
      const host = target.__typename === 'Issue' ? target.issue : target.pull;
      const repo = target.repo;
      if (!host || !repo) {
        exec.errors.push({ message: 'Could not resolve the subject for addComment' });
        return null;
      }
      const at = tick();
      const comment: CommentRec = {
        id: nextCommentId,
        body: typeof input.body === 'string' ? input.body : '',
        createdAtSec: at,
        updatedAtSec: at,
      };
      nextCommentId += 1;
      host.comments.push(comment);
      const node = commentObject(repo, comment);
      const edge = { __typename: 'CommentEdge', payload: { nodeRaw: node, cursor: `cursor-${comment.id}` } } as GqlObject;
      return payloadOf('AddCommentPayload', { commentEdge: edge, subject: target });
    }
    case 'createPullRequest': {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.type === 'Repository' ? findRepoById(Number(parsed.parts[0])) : undefined;
      if (!repo) {
        exec.errors.push({ message: 'Could not resolve the repository for createPullRequest' });
        return null;
      }
      const result = createPullRecord(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if (!result.ok) {
        exec.errors.push({ message: result.message });
        return null;
      }
      return payloadOf('CreatePullRequestPayload', { pullRequest: pullObject(repo, result.pull) });
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? gqlFindByGlobalId(input.pullRequestId) : null;
      if (!target || target.__typename !== 'PullRequest' || !target.pull || !target.repo) {
        exec.errors.push({ message: 'Could not resolve the pull request' });
        return null;
      }
      const outcome = mergePull(target.repo, target.pull);
      if (!outcome.ok) {
        exec.errors.push({ message: 'Pull Request is not mergeable' });
        return payloadOf('MergePullRequestPayload', { pullRequest: target });
      }
      return payloadOf('MergePullRequestPayload', { pullRequest: target });
    }
    case 'updatePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? gqlFindByGlobalId(input.pullRequestId) : null;
      if (!target || target.__typename !== 'PullRequest' || !target.pull) {
        exec.errors.push({ message: 'Could not resolve the pull request' });
        return null;
      }
      if (typeof input.title === 'string') target.pull.title = input.title;
      if (typeof input.body === 'string') target.pull.body = input.body;
      if (input.state === 'CLOSED' && target.pull.state === 'open') {
        target.pull.state = 'closed';
        target.pull.closedAtSec = tick();
      }
      target.pull.updatedAtSec = tick();
      return payloadOf('UpdatePullRequestPayload', { pullRequest: target });
    }
    default:
      exec.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

function gqlRootField(operation: 'query' | 'mutation', field: GqlField, exec: GqlExec): unknown {
  if (operation === 'mutation') return gqlMutation(field, exec);
  const args = gqlArgs(field, exec);
  switch (field.name) {
    case 'viewer':
      return userObject();
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (owner.toLowerCase() !== VIEWER.login) return null;
      const repo = findRepo(owner, name);
      return repo ? repoObject(repo) : null;
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      return gqlFindByGlobalId(id);
    }
    case 'nodes': {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      return ids.map((id) => (typeof id === 'string' ? gqlFindByGlobalId(id) : null));
    }
    case 'user': {
      const login = typeof args.login === 'string' ? args.login : '';
      return login.toLowerCase() === VIEWER.login ? userObject() : null;
    }
    case 'organization':
      return null;
    case 'search':
      return connectionObject('SearchResultItemConnection', [], () => 'none');
    case 'rateLimit':
      return { __typename: 'RateLimit', payload: { limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: iso(EPOCH_SEC + 3600) } } as GqlObject;
    case '__type': {
      const name = typeof args.name === 'string' ? args.name : '';
      if (GQL_TYPE_FIELDS[name] || GQL_ENUM_VALUES[name] || GQL_KINDS[name]) {
        return { __typename: '__Type', typeName: name } as GqlObject;
      }
      return null;
    }
    case '__schema':
      return { __typename: '__Schema' } as GqlObject;
    default:
      exec.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
      return null;
  }
}

function gqlExecuteOperation(document: GqlDocument, operationName: string | null, variables: Record<string, unknown>): Record<string, unknown> {
  const exec: GqlExec = { variables, fragments: document.fragments, errors: [] };
  let operation: GqlOperation | undefined;
  if (operationName !== null) operation = document.operations.find((candidate) => candidate.name === operationName);
  if (!operation) operation = document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation in the document' }] };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      data[key] = operation.operation === 'mutation' ? 'Mutation' : 'Query';
      continue;
    }
    if (selection.name === '__type' || selection.name === '__schema') {
      const resolved = gqlRootField(operation.operation, selection, exec);
      data[key] = gqlComplete(resolved, selection.selections, exec);
      continue;
    }
    const resolved = gqlRootField(operation.operation, selection, exec);
    data[key] = gqlComplete(resolved, selection.selections, exec);
  }
  const out: Record<string, unknown> = { data };
  if (exec.errors.length > 0) out.errors = exec.errors;
  return out;
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    notFound(res);
    return;
  }
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    }
    const body = entry as Record<string, unknown>;
    const query = typeof body.query === 'string' ? body.query : '';
    if (query === '') return { data: null, errors: [{ message: 'No GraphQL query given' }] };
    const variables =
      body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)
        ? (body.variables as Record<string, unknown>)
        : {};
    const operationName = typeof body.operationName === 'string' ? body.operationName : null;
    try {
      const document = new GqlParser(gqlTokenize(query)).parseDocument();
      return gqlExecuteOperation(document, operationName, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ----------------------------------------------------------------------------------------------
// MCP (/mcp)
//
// JSON-RPC 2.0 over the Streamable HTTP transport. The server speaks the modern revision
// (server/discover answers supportedVersions) and the legacy handshake (initialize +
// notifications/initialized). The tools act on the same store as REST and GraphQL. The
// tools/list answer is a module-level constant, so two calls are byte-identical.

const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner login'), repo: stringProp('The repository name') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        issue_number: { type: 'integer', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        pull_number: { type: 'integer', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type McpToolOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

function mcpRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (owner.toLowerCase() !== VIEWER.login || name === '') return null;
  return findRepo(owner, name) ?? null;
}

function mcpCallTool(name: string, args: Record<string, unknown>): McpToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '' || repoName.includes('/')) return { ok: false, message: 'A repository name is required' };
      if (findRepo(VIEWER.login, repoName)) return { ok: false, message: `Repository ${repoName} already exists` };
      const repo = createRepoRecord({
        name: repoName,
        isPrivate: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
        defaultBranch: 'main',
      });
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = mcpRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = mcpRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const issue = createIssueRecord(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = mcpRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return { ok: true, value: list.map((issue) => issueJson(repo, issue)) };
    }
    case 'get_issue': {
      const repo = mcpRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (!issue) return { ok: false, message: 'Issue not found' };
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'create_pull_request': {
      const repo = mcpRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const result = createPullRecord(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head: typeof args.head === 'string' ? args.head : '',
        base: typeof args.base === 'string' ? args.base : '',
      });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, value: pullJson(repo, result.pull) };
    }
    case 'list_pull_requests': {
      const repo = mcpRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      return { ok: true, value: list.map((pull) => pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = mcpRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return { ok: false, message: 'Pull request not found' };
      const outcome = mergePull(repo, pull);
      if (!outcome.ok) return { ok: false, message: 'Pull Request is not mergeable' };
      return {
        ok: true,
        value: { pull_number: pull.number, number: pull.number, merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' },
      };
    }
    default:
      return { ok: false, message: `Unknown tool ${name}` };
  }
}

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Answer one parsed JSON-RPC message; null means "notification: no response body". */
function mcpDispatch(message: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const hasId = 'id' in message;
  const id = message.id ?? null;
  const params = (message.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return mcpResult(id, {
        resultType: 'complete',
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return mcpResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
      });
    }
    case 'ping':
      return mcpResult(id, {});
    case 'tools/list':
      return mcpResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) return mcpError(id, -32601, `Unknown tool: ${toolName || '(none)'}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return mcpError(id, -32602, 'Tool arguments must be an object');
      }
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      for (const key of required) {
        if (args[key] === undefined || args[key] === null || args[key] === '') {
          return mcpError(id, -32602, `Missing required argument: ${key}`);
        }
      }
      const outcome = mcpCallTool(toolName, args);
      if (!outcome.ok) {
        return mcpResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
      }
      const text = JSON.stringify(outcome.value);
      return mcpResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    default:
      if (!hasId) return null; // A notification we do not track: accept silently.
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    // A legacy session goodbye; we hold no sessions, so there is nothing to refuse.
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end('{}');
    return;
  }
  if (method !== 'POST') {
    notFound(res);
    return;
  }
  const raw = (await readBody(req)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A body that is not JSON is a JSON-RPC parse error, answered 400 with -32700.
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) =>
        entry !== null && typeof entry === 'object' ? mcpDispatch(entry as Record<string, unknown>) : null,
      )
      .filter((entry) => entry !== null);
    sendJson(res, 200, answers);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const message = parsed as Record<string, unknown>;
  if (!('id' in message) && typeof message.method === 'string' && message.method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  const answer = mcpDispatch(message);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

// ----------------------------------------------------------------------------------------------
// Router

function safeUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = safeUrl(req);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/graphql' || path === '/api/v4/graphql' || path === '/api/v3/graphql') {
    await handleGraphQL(req, res);
    return;
  }
  if (path === '/mcp' || path === '/mcp/') {
    await handleMcp(req, res);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, url);
    return;
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    await handleGit(req, res, url, gitMatch);
    return;
  }
  notFound(res);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-github-request-id', requestId());
    route(req, res).catch(() => {
      // A bad request must never take the process down: answer 500 and keep serving.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing to answer on.
      }
    });
  });
}
