# Forge — build notes

## Wave 1 (done): foundation + git core

- `git-core.ts` — sha1 object store, packfile read (v2/v3, ofs/ref deltas, thin packs resolved
  against the store, trailer verified) and write (self-contained, no deltas), pkt-line framing,
  commit/tree/tag parsing, reachability, and `planFetch` (want/have closure minus have closure,
  generation-bounded shallow cuts with shallow/unshallow bookkeeping).
- `app.ts` — HTTP routing for all four surfaces; REST v3 minimum (root, meta, user, repo
  create/list/get/patch/delete with Link pagination); smart HTTP: v2 advertisement + ls-refs +
  fetch (negotiation rounds, `ready` semantics, shallow-info), v0 advertisement + fetch (two-POST
  shallow dance handled), receive-pack v0 with per-ref fast-forward enforcement and
  report-status in sideband. Bearer auth against `MAKEFUN_SHOP_TOKEN`; the token's login is the
  scenario viewer (`adaiversen`, id 1000). Every handler is crash-wrapped: malformed input is a
  JSON 400/404, never a process exit.
- Verified: the kit's own conformance suite — **git group 30/30**; REST repos checks that do not
  depend on wave-2 surfaces pass (pagination, root, meta, create, not-found, foreign-token) and
  protocol checks pass wherever their setup does not need contents. Real git CLI (2.43) end-to-end
  on both protocol versions: clone empty/full/shallow, push, fetch, deepen, tags, branch
  create/delete, non-FF and mixed pushes, 100-file round-trip byte-exact, `git fsck` clean.

## Wave 2 (done): REST data surfaces, GraphQL, MCP

- REST: contents API (PUT/GET/DELETE `/repos/{o}/{r}/contents/{path}` — commits on unborn
  repos, branch creation via `branch`, 409 on a stale sha, directory listings), git database
  (`/git/refs` create/list/get/patch/delete, `/git/commits`, `/git/trees`, `/git/blobs`,
  `/git/tags`), branches + single branch, commits list/get, labels, issues + comments
  (state/sort/direction, shared issue/PR number sequence), pulls (create/list/get/files with
  an LCS line diff, squash merge via a three-way tree merge against the merge base — 405 on
  conflict, 404 on unknown).
- GraphQL at `/api/graphql` (also `/api/v4/graphql`): a small hand-rolled parser/executor —
  viewer, repository, node(id:), issues/pullRequests connections with cursor pagination and
  orderBy, introspection (`__type` field/enum tables for Issue, PullRequest, Repository,
  SearchType, …), mutations createIssue/closeIssue/reopenIssue/updateIssue/addComment/
  createPullRequest/mergePullRequest/updatePullRequest, operation batching (JSON array body),
  unknown field → 200 + `errors` naming the field, unknown repository → `data.repository =
  null`. Global ids are opaque base64 (`Type:parts`), stable across reads.
- MCP at `/mcp`: JSON-RPC 2.0; `server/discover` (modern revision 2026-07-28,
  supportedVersions list) plus the legacy `initialize` handshake; `tools/list` is a
  module-level constant (byte-identical across calls) with 8 tools — the required six
  (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request)
  plus get_issue and list_pull_requests. Unknown tool → -32601, missing required argument →
  -32602, non-JSON body → HTTP 400 with -32700, no Authorization → 401. Tools act on the same
  store as REST/GraphQL.
- Verified: the kit's full conformance suite in one process, env registration order —
  **120/120** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, graphql 20/20, mcp 15/15,
  protocol 5/5). Real git CLI smoke (clone empty, push, slashed branch push, shallow clone,
  fsck clean) still passes. Bench shapes are fast locally (200 issue writes ≈ 0.34 s, 2,000
  issue reads ≈ 1.4 s in-process over loopback).

Gotchas learned in wave 2:

- Connection pagination arguments (`first`, `after`) arrive on the field that produces the
  connection (`issues(first: 5, after: …)`), not on `nodes`/`pageInfo` — the connection
  object captures them (`pageArgs`) and `nodes`/`edges`/`pageInfo` slice with them.
- Node's strip-types mode rejects TypeScript parameter properties; keep classes on plain
  field declarations.
- A contents PUT addressed at a not-yet-existing branch must parent the new commit on the
  default branch's tip (the suite's MCP setup relies on branch creation through contents
  when `/git/refs` is unavailable — ours serves both).

## Protocol gotchas (learned against real git; the suite tolerates more)

- v2 fetch: when the client sends `done`, send NO acknowledgments section; when it withholds
  `done` and a common have exists, answer ACKs + `ready` AND the packfile in the same response.
- v0 fetch: a request without `done` gets only the shallow section (or ACK lines) — never the
  pack; the client replays the full request with `done` for the pack, and expects the shallow
  section again, flush-terminated, before the NAK.
- v0 receive-pack: the report-status stream inside band 1 must end with its own flush packet.
- v0 upload-pack advertisement must carry `deepen-since deepen-not deepen-relative` or git
  refuses `--deepen` fetches.
