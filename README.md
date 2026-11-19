# Demetra Forge — a GitHub core clone in a single Node process

![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/Demetraaa/demetra-forge/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/Demetraaa/demetra-forge/reward.svg)

A from-scratch git forge built for [the github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01):
one Node 22 process, standard library only, no `git` binary, no network. It implements the four
surfaces the contest scores — git smart HTTP, REST v3, GraphQL v4 and MCP — over its own
SHA-1 object store with packfile read/write.

## What works

- **Git smart HTTP** — protocol v2 and v0: advertisement, ls-refs, clone, fetch (incremental,
  shallow, deepen), push with fast-forward enforcement and sideband report-status. Packfiles are
  parsed (ofs/ref delta chains, thin packs) and written by `git-core.ts`; verified end-to-end with
  the real `git` CLI and `git fsck --strict`.
- **REST v3** — repositories, branches, commits, contents (create/update/delete with real commits),
  the git database (`/git/refs`, `/git/commits`, `/git/trees`, `/git/blobs`, `/git/tags`), labels,
  issues and comments, pull requests with a three-way squash merge.
- **GraphQL v4** — viewer, repository, node lookups, issues/pullRequests connections with cursor
  pagination and `orderBy`, introspection, and the mutations the suite exercises.
- **MCP** — streamable HTTP endpoint with discovery, `tools/list` and eight tools that act on the
  same store as the REST and GraphQL surfaces.

Local score against the kit's own conformance suite: **120/120 checks** (git 30, repos 15,
issues 15, pulls 20, graphql 20, mcp 15, protocol 5).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own files only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## Layout

- `main.ts`: the harness lifecycle above, unchanged from the starter.
- `app.ts`: the server — routing, auth, REST, GraphQL, MCP and the smart-HTTP handlers.
- `git-core.ts`: the object store, packfiles, pkt-line framing and fetch planning.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
- `.makefun/owner.json`: the make.fun ownership claim file for this repository.

The contest rules, scoring weights, deadline and prizes are on
[the bounty page](https://make.fun/bounty/github-core-clone-01). This entry is MIT licensed.
