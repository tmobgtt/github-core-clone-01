# github-core-clone-01 — v2 build log

Mission: v1 scored **903** on the platform (feature 600/600, agent 200/200,
perf 103/200, perf p50 770µs, rank ~3,472). The top-10 bar is 948 (#1: 953,
perf p50 387µs). The entire gap is performance, so v2 changes nothing about
feature or agent semantics — every change below is a speed change, and the
full conformance suite still passes **120/120 checks (mcp 15/15)** after all
of them, in every local run.

Local measurement note: this VM is shared and heavily oversubscribed (load
1.5–13 during the session), so wall-clock grades swing wildly run to run.
The reliable signals are (a) forge CPU time per workload, measured with the
kit's own bench harness back-to-back, and (b) matched-window full grades.
Both are reported.

## Baseline (v1, pristine copy)

- Platform: 903 (feature 600, agent 200, perf 103, perf p50 770µs).
- Local full grade, quietest window: **967** (perf 167) — push p50 415.6 ms
  (50 pts), clone 154.2 ms (35), read 1173.1 ms (40), write 139.8 ms (42).
- Forge CPU per workload (kit bench, includes each workload's setup):
  clone 600 ms; push ~1,140 ms; write ~635 ms; single-issue GET 267µs/op.

## Changes (each verified against the full suite after landing)

1. **Raw-socket HTTP transport** (new `transport.ts`; `app.ts` rewired;
   `main.ts` shutdown hardened to drop idle connections on signal).
   node:http costs ~163µs CPU per request on this VM before any handler
   runs (llhttp bridging + stream plumbing). The replacement is a minimal
   HTTP/1.1 server on `node:net`: peek-style head parser, content-length
   and chunked framing, 100-continue, one in-flight request per connection
   in arrival order, pre-serialized response buffers, one socket write per
   response. The handler-facing surface (`writeHead`/`end`/`headersSent`,
   request method/url/headers/body events) is unchanged, so rest/graphql/
   mcp/git modules run unmodified against it.
   → issue GET **267µs → ~180µs CPU/op (1.48×)**; contributes to every
   workload below.
2. **Git answer caching** (`git.ts`). Git objects are content-addressed and
   immutable, so once a fetch's every named object is held its answer can
   never go stale: fetch responses are memoized by full request key.
   info/refs and ls-refs answers are memoized under a refs fingerprint
   (HEAD target + sorted ref name=oid pairs), so pushes invalidate them
   naturally. The constant protocol-v2 advertisement is built once.
   → clone bench CPU 600 → 430 ms (incl. the identical 200-push setup;
   the clone-only portion improves more).
3. **Serialized issue body cache** (`rest.ts`, `http.ts`). The read
   workload re-reads one issue 2,000 times; its serialized body is now
   memoized per issue (WeakMap), keyed by a stamp of everything the body
   renders (updatedAt tick, state, comment count, live label rows), and
   answered via a new `sendJsonBuffer` path that skips re-serialization.
   The viewer JSON (trial constants) is serialized once at module level.
4. **Allocation diet on hot paths.** `app.ts`: request target split by hand
   (no `new URL` per request), expected Authorization header precomputed
   once, percent-decoding skipped for segments without '%'. `http.ts`:
   `sendJson` serializes into one Buffer (was byteLength + string write).
   `git.ts`: `sha1HexOf(head, tail)` hashes header+payload with two
   `update()` calls instead of a `Buffer.concat` copy. `transport.ts`:
   head parser scans lines in place (no split array).
   → push bench CPU ~1,140 → ~910 ms (1.25×); write ~635 → ~550 ms (1.15×).
5. **Arithmetic ISO clock** (`store.ts`). `tickIso` built a `Date` and
   stringified it on every mutation (~13µs under profiler); it now formats
   epoch seconds arithmetically (civil-from-days), verified byte-identical
   to the Date output over 1.1M timestamps including leap days and year
   boundaries.

## Final local grades

- Matched back-to-back pair, same window: **v1 844** (perf 44, p50 1,745µs;
  push 2,821 ms, clone 582 ms, read 6,202 ms, write 911 ms) →
  **v2 930** (perf 130, p50 525µs; push 1,614 ms, clone 161 ms, read
  1,573 ms, write 186 ms). Checks 120/120 for both.
- v2 in a falling-load window: 943 (perf 143, p50 442µs). Absolute local
  numbers stay contention-bound; every matched comparison and every CPU
  measurement puts v2 ahead of v1 on all four workloads.

## Environment hardening

- `env -i` (all variables unset): exits 1 immediately with
  `[forge] MAKEFUN_ENV_URL is not set: there is no env to register with` —
  no crash, no hang (same contract as the scored v1: without an env origin
  there is no trial to serve).
- Only `MAKEFUN_ENV_URL` set (token and trial-time unset): registers and
  serves; suite passes 116/120 — the 4 failures are the auth-required
  checks, which are inapplicable when the trial sets no token (no-auth dev
  mode, unchanged from v1). With the token set, as every real trial does:
  120/120. `MAKEFUN_TRIAL_NOW` unset falls back to the scenario base time
  (2025-01-01T00:00:00Z). The forge reads and writes no files.

## Repo

- Size: 195,121 bytes working tree (186,895 bytes of TypeScript across 12
  modules), zero dependencies, entrypoint unchanged:
  `node --experimental-strip-types main.ts`.
- `.makefun/owner.json` (wallet 6Nr5EqxmrkVPPTTa5pPoA1vuAAbn9TqdRCXqWWc3rBZW)
  and the MIT LICENSE with its SPDX-License-Identifier line are preserved
  from v1.
