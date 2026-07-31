# Letter to agy

A handoff + current problem summary before you take over the Antigravity CLI
(`agy`) pass on this machine. Context, evidence, and the two failure modes to
untangle live below.

## 0. Where we are

- **Repo:** `/root/agentica` (workspace root). Branch `reskin-agents`.
- **Local dev stack is already up** (started by the human via `scripts/dev-local.sh`):
  - Web: Next dev on `localhost:3000`.
  - API (Bun, `bun run --hot src/index.ts`, PID 74937) in container
    `810a9298abb2`, `http://localhost:8008/v1`. Hot-reloads on file save.
  - Supabase local on `127.0.0.1:54321` (container `supabase_db_kortix-local`).
  - E2B account = **Hobby tier** (max sandbox TTL = 1 hour). Key in
    `apps/api/.env.local` (`E2B_API_KEY`).
- **Recent commit:** `ca22b535d` "fix: E2B SDK option keys — sandbox envs + 1h TTL
  actually applied, proxy URL scheme, not_found reprovision".
  That round fixed three *silent* SDK mistakes that were killing every E2B
  sandbox within 5 minutes of provision (no env vars, 5-min default TTL, broken
  proxy URL). Verified live: provisioning succeeds, TTL is now 1h, envs land,
  and the proxy reaches the daemon.

## 1. What the user did

1. Logged in (jessenat3@gmail.com, account `1e17a527-3020-479f-854c-6a7e24771eec`).
2. Opened / created a session via the **web UI** on project
   `9ce06005-e747-4a6e-a059-64d6e74dbc0a` ("E2B Test Project",
   repo `https://github.com/Dosco-Inc/e2b-test-project-9ce06005-e747-4a6e-a059-64d6e74dbc0a.git`).
3. Saw two errors:
   - `Request exceeded the 25s server processing deadline`
   - `{"error":"sandbox upstream unreachable","port":8000,"status":502}`

## 2. What actually happened (evidence)

### 2a. `GET /v1/projects/9ce06005.../sandboxes` → 503 "Request exceeded the 25s server processing deadline"

API log (container 810a9298abb2), right after `/start`:
```
[2026-07-31T07:27:26.947Z] [INFO] ... POST .../sessions/95b843ba.../start 200 1128ms
[2026-07-31T07:27:27.869Z] [ERROR] GET .../sandboxes -> 503 [HTTPException] {"message":"Request exceeded the 25s server processing deadline","path":"/v1/projects/9ce06005.../sandboxes","method":"GET"}
```

Route: `r2.ts:366 GET /:projectId/sandboxes` → `listSandboxTemplates`
(`snapshots/builder.ts:434`) → `listTemplatesForProject` (`snapshots/templates.ts:211`)
→ `syncTomlTemplatesForProject` → `readManifest` → `readRepoFile`
(`projects/triggers.ts:132`).

DB shows the smoking gun:
```
postgres=# select installation_id from agentica.account_github_installations
           where account_id='1e17a527-3020-479f-854c-6a7e24771eec';
(empty — the account has NO GitHub App installation)
```
With no GitHub App install, `resolveProjectGitAuth` returns no token, so
`readRepoFile` runs an **unauthenticated** host-side git fetch against
`github.com/Dosco-Inc/e2b-test-project-…`. Per the in-code warning at
`git.ts:951`, a tokenless caller on a private repo can drive the cold bare-clone
into `fatal: could not read Username for github.com` and the git fetch blocks
(credential prompt / retries / DNS) until the
`middleware/request-deadline.ts` (default 25s, line 45) fires → clean 503.

A sibling session already told us the auth story: session `5a39c780…`
failed with `Couldn't access the project's Git repository (authentication
failed)`.

**So symptom (2a) is the project/repo lacking a GitHub App installation for this
account → host git ops hang → 25s wall-clock deadline kills the request.**

> Note: this is *not* the E2B sandbox itself — it's the *template-list* read
> path. The session provision (2b) is fine; the UI's template refresh is what
> timed out.

### 2b. `GET /v1/p/i38t85k7zp4v4yyz0h9gy/8000/kortix/health` → 502 `sandbox upstream unreachable`

- Sandbox `i38t85k7zp4v4yyz0h9gy` provisioned for session `95b843ba…`. DB row:
  `status=active, initStatus=ready`, provisioned in 21.5s via the **image-cached**
  path (marks: `row+tokens 424ms → image-cached 19219ms → provider-create 1864ms`),
  E2B TTL = +1h (the fix works).
- The preview proxy (`sandbox-proxy/routes/preview.ts`) polls the E2B upstream
  `https://8000-i38t85k7zp4v4yyz0h9gy.e2b.app/kortix/health` while the in-sandbox
  daemon boots. Daemon boot timeline (fresh provision):
  ```
  pool-ready 952ms → pool-opencode-ready 15074ms (~15s)
  ```
- The proxy retry budget is `RETRY_DELAYS_MS = [250, 1000, 3000]` ≅ **4.25s**
  (`preview.ts`). Each attempt also has a 15s per-fetch `AbortSignal.timeout`.
  During boot the E2B traffic gateway returns `503 port not ready`; after ~4s of
  retries the proxy exhausts → falls through to `portUnreachableResponse`
  (`preview.ts:587`).
- Crucially: **non-browser-navigation** JSON polls (the dashboard's
  `fetch('/v1/p/.../kortix/health')` with `accept: application/json`, no
  `sec-fetch-dest: document`) hit the `else` branch → **502 "sandbox upstream
  unreachable"** (`preview.ts:587-593`), while a true browser nav would get the
  friendlier 503 "port unreachable". So JSON health polls get a *terminal* 502
  instead of a retryable one.
- Verified now (07:35+): once the daemon is up, the same proxy path returns
  `{"daemon":"ok","status":"ok","runtimeReady":true,"opencode":"ok",
  "uptime_s":≈1900}` reliably (tested as jessenat3's own token). So the 502 is
  strictly a **boot-window + retry-budget-too-short** issue, not a dead box.

> Note: while debugging I connected to sandbox `iolu11ci7v0dizn6v9qls` for an
> earlier session and ran `s.kill()` at the end of my probe — that sandbox is now
> gone. The current healthy target is `i38t85k7zp4v4yyz0h9gy` for session
> `95b843ba…`. Don't reuse it as a "stable" target; spin fresh ones.

## 3. Current state of the two sessions under test

```
session 95b843ba…  (jessenat3 / 1e17a527, project 9ce06005)
  status=running, external_id=i38t85k7zp4v4yyz0h9gy, initStatus=ready, TTL=+1h
  sandbox row healthy; daemon on :8000 healthy via proxy now.
session 10a1d70f…  (sd@gmail.com / 88f40287, project d0cbe714)
  left running/active from my earlier verification; sandbox i40wzwz8… is now dead
  (I killed it). DB row still says active → will reconcile to not_found on next
  reaper pass or next open.
```

## 4. What's been fixed / is verified already (so agy doesn't re-tread)

- `platform/providers/e2b.ts`: `envs` + `timeoutMs` (was silently dropped keys
  `envVars`/`timeout` → 5-min TTL + no env vars). TTL clamped to E2B Hobby 1h
  max (`400: Timeout cannot be greater than 1 hours` — Pro allows 24h; this
  account is Hobby, so use 1h). `getHost()` → `https://` prefix in
  `resolvePreviewLink`/`resolveEndpoint` (was scheme-less → `"… cannot be parsed
  as a URL"` → 502). `Sandbox.list({ query.metadata })` (was `metadata` — no-op,
  listed unfiltered). `getStatus` → `not_found` on `SandboxNotFoundError`;
  `ensureRunning` throws.
- `providers/index.ts`: `SandboxStatus` gains `'not_found'`.
- Reaper (`sandbox-reaper.ts`), `routes/shared.ts`, `session-lifecycle/actions.ts`:
  `not_found` treated like `removed` → reconcile row to `stopped` +
  `needsReprovision` → next open reprovisions a fresh box.
- `snapshots/providers/e2b.ts`: import `getE2BApiKey` (was a missing-symbol
  error), removed invalid `timeoutMs` from `Template.build` (only
  `requestTimeoutMs` exists).
- Tests: `unit-e2b-provider.test.ts` (18 tests), `unit-e2b-adapter.test.ts`
  (7, fixed fetch mock for `getSnapshotState`) green. The 2 pre-existing
  `reapOrphanProviderBoxes` failures (`config.ALLOWED_SANDBOX_PROVIDERS` undefined
  in that test's mock) are unrelated and out of scope.
- Typecheck: no new errors on touched files (only the pre-existing
  `billing/routes/subscriptions.ts` unresolved names remain).

## 5. Open questions / where agy should start

### Primary (blocks the user)
1. **`GET /v1/projects/:id/sandboxes` hangs ~25s.** It's not E2B — it's
   `listTemplatesForProject` → `syncTomlTemplatesForProject` → `readRepoFile` /
   git fetch on a repo the account can't authenticate to. Two real questions:
   - **Is `1e17a527` actually supposed to have a GitHub App installation?**
     `account_github_installations` is empty for it. The repo
     `Dosco-Inc/e2b-test-project-…` belongs to org `Dosco-Inc`; jessenat3 may
     not have installed the Dosco Kortix GitHub App there, OR the App
     installation never got recorded. If the user genuinely can't read that
     repo, the endpoint should fail fast — not block for 25s.
   - **Bound the host git read.** `readRepoFile`/`readManifest` should fail-fast
     (e.g. a 5s git-level timeout or `insteadOf` non-interactive) and surface a
     clean 401/403 (or `readManifest`'s catch returning `null` fast) rather than
     letting git block until the global 25s deadline. That single change would
     turn the 503-deadline into a near-instant, retryable auth error.

2. **Preview proxy returns a terminal 502 (not a retryable 503) to JSON health
   polls during boot.** `sandbox-proxy/routes/preview.ts:587`: when retries
   exhaust, browser *navigations* get `"port unreachable"` (503) but
   `fetch(...)` health polls (non-browser-nav) get `"sandbox upstream
   unreachable"` **502**. Two fixes to consider:
   - Return a retryable 503 (with `Retry-After`) to JSON clients too during the
     "port not ready / still booting" window — the current 502 makes the UI
     believe the sandbox is dead when it's just 15s into boot.
   - OR grow the proxy retry budget / switch to a longer, polled readiness wait
     for E2B (daemon boot is ~15s, retry budget is ~4s). The daemon's own
     `opencode` readiness takes ~15s; the proxy shouldn't declare "unreachable"
     before then.

### Secondary / hygiene
3. **Reconsider E2B TTL now that Hobby max is 1h.** The TTL fix caps at 1h. For
   long-running sessions this will still GC'd after 1h of *lifetime* (TTL,
   not idle). The API stops/kills on session close, so 1h is usually enough, but
   it's worth noting this isn't "persistent" — revisit if users run >1h sessions.
   (`Sandbox.setTimeout(...)` can extend a live sandbox's TTL; the daemon's
   `/health` could ping that on activity as a keep-alive, but there's no such
   ping yet.)
4. **`GET /sandboxes` should be exempt from the 25s deadline** (it's a read), and
   its per-template `getSnapshotState` fetches (8s-bounded each) plus the git
   toml sync should all be strictly bounded so the route can never silently
   approach the deadline.
5. The 403-flood from the orphaned pre-fix sandbox `iqy2rooj3y7xslenhdsc2`
   (daemon polling `/v1/p/.../kortix/health` every ~10s, denied, ~380/10min) is
   harmless and should stop on its own once E2B GC's the daemon; killable via
   `Sandbox.kill` if noisy.

## 6. How to reproduce on this box

```bash
# API is live: curl http://localhost:8008/v1/health  (uptime ~17h, hot-reload on)
# Mint jessenat3's JWT (service role key is in apps/api/.env.local, plaintext, gitignored):
SRK=$(grep ^SUPABASE_SERVICE_ROLE_KEY= apps/api/.env.local | cut -d= -f2-)
# (reset password if needed) then:
ANON=$(grep ^NEXT_PUBLIC_SUPABASE_ANON_KEY= apps/web/.env.local | cut -d= -f2-)
curl -X POST 127.0.0.1:54321/auth/v1/token?grant_type=password \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"jessenat3@gmail.com","password":"jess123456"}'

# Reproduce (2a):
curl http://localhost:8008/v1/projects/9ce06005-e747-4a6e-a059-64d6e74dbc0a/sandboxes \
  -H "Authorization: Bearer <JWT>"   # → 503 after ~25s (deadline) on first call;

# Reproduce (2b): open + poll the proxy during boot:
curl -X POST .../sessions/95b843ba.../start -H "Authorization: Bearer <JWT>" -d '{}'
curl http://localhost:8008/v1/p/<ext>/8000/kortix/health -H "Authorization: Bearer <JWT>"
# (502 during boot; 200 once the daemon is up ~15s later)
```

## 7. Files worth opening

- `apps/api/src/middleware/request-deadline.ts` — the 25s wall-clock guard.
- `apps/api/src/sandbox-proxy/routes/preview.ts` — retry budget (4x) + the
  502-vs-503 branch at line 587.
- `apps/api/src/snapshots/templates.ts:142` (`syncTomlTemplatesForProject` →
  `readRepoFile`), `apps/api/src/projects/triggers.ts:132` (`readManifest`).
- `apps/api/src/projects/lib/git.ts:931` (`loadGitProject`),
  `apps/api/src/projects/lib/access.ts` (`resolveProjectGitAuth` / GitHub App
  install resolution) — the `account_github_installations` table is empty for
  `1e17a527`.
- `apps/api/src/platform/providers/e2b.ts` (the fixed provider — reference for
   what's working).

## 8. Latest work since the last handoff (this pass)

### 8a. Preview proxy no longer fatals JSON health polls to a terminal 502 during boot
`sandbox-proxy/routes/preview.ts` (open item #2 in section 5): on retry exhaustion,
non-browser (JSON) health polls now get a **retryable 503 + `Retry-After`** instead
of a 502 `"sandbox upstream unreachable"`. The branch is:

- `portUnreachableResponse` now accepts an optional `retryAfter` and emits a
  `Retry-After: <seconds>` header (only when provided; no-store cache-control on all
  error responses so the dashboard always re-polls).
- The retries-exhausted 502/503 block now returns, for non-browser-nav clients, a 503
  with `Retry-After = max(ceil((nextReadyAtMs - now)/1000), 3)`. Browser nav still
  gets the friendly HTML 503 "port unreachable" page. (Confirmed-dead boxes —
  transport errors / dead-signal — still return a terminal 502.)

The rationale is in the code comment at the branch: a not-confirmed-dead sandbox
(polling the daemon that's mid-boot) must signal "retry later", not "this box is
dead" — the 502 was making the dashboard hard-fail during the ~15s daemon boot.

New unit tests in `e2e-preview-proxy.test.ts` (46 total now, was 44):
- `returns 502 on transport errors (fetch throws), not a retryable 503` — confirms
  genuine dead boxes still fatal-502 (sawDeadSignal / all-fetches-threw path).
- `returns retryable 503 (with Retry-After) when upstream returns 503 "port not
  ready" at exhaustion` — confirms a boot-window 503 (port not listening) surfaces as
  retryable 503+Retry-After, not 502.

Both green. Full file: 45 pass / 1 fail (the 1 fail —
`syncs latest project secrets before forwarding prompt_async` — fails on the clean
tree too; pre-existing body-shape mismatch, unrelated to this change).

### 8b. Live verification just now (08:48Z)
Spun a fresh session for `sd@gmail.com` / project `d0cbe714` (buht account),
provisioned via the image-cached E2B path, and polled the proxy with the correct
`sandbox_id`:

```
sandbox_id: istmraomg2mx7ukwml2x0   (e2b sandbox external id)
session_id: efb8e816-15a9-436d-9b5c-5887a8ebc238   (DB row; sandbox_id != session_id here)
GET .../p/istmraomg2mx7ukwml2x0/8000/kortix/health  →
  {"daemon":"ok","status":"ok","runtimeReady":true,"opencode":"ok",
   "uptime_s":6168,"opencode_pid":470,"static_web_port":3211,
   "repo_required":false,"repo_ready":true,
   "repo":"/opt/kortix/scaffold.git","branch":"main",
   "boot_timeline":[{"label":"static-web","atMs":25},...
                    {"label":"pool-opencode-ready","atMs":9080},
                    {"label":"pool-seed-session","atMs":9098}],
   "auth":"unconfigured"}   [HTTP 200]
```

Daemon healthy, runtimeReady, OpenCode ready (`opencode-ready` at 9080ms ≈ 9s),
repo scaffolded, `auth:"unconfigured"` (this project/sandbox doesn't need project
auth tokens — expected). The `sandbox_url` the UI is handed is
`https://api.dosco.live/v1/p/istmraomg2mx7ukwml2x0/8000` — i.e. the proxy routes by
**sandbox_id**, not session_id. (When I first polled using the session_id
`efb8e816…` the proxy returned `{"error":"sandbox not found"}` — easy mistake; the
UI uses the sandbox_id in the URL it stores on the session row.)

### 8c. Still open
- (2a) `GET /v1/projects/9ce06005/sandboxes` still hangs ~25s for `1e17a527` because
  that account has **no GitHub App installation** (`account_github_installations`
  empty) and `readRepoFile`'s unauthenticated git fetch to github.com blocks until the
  25s `request-deadline` fires. Not yet bounded server-side.
- Typecheck is clean on touched files (`bun x tsc --noEmit` → no errors on preview
  / e2b provider / e2b adapter).

  agy, take it from here.

  
