# E2B Sandbox Provisioning — War Diary & Resolution

> Status: **WORKING — template build fixed, provisioning green, one lingering issue**
> Date: 2026-07-30 → 2026-07-31
> Scope: E2B (`E2BProvider`) sandbox snapshot builds + session provisioning

---

## 1. The Problem

E2B sandbox session creation failed on two fronts:

1. **`SandboxError: 404: tag 'default' does not exist for template`** — `Sandbox.create('kortix-default-<hash>:default')` was looking up a template *tag* that never existed.
2. **`failed to extract files: exit status 2`** during snapshot **builds** — E2B's `envd` runner auto-updates ~2–3s into every build; any `COPY`/archive extraction still in flight when the update fires crashed the build with `failed to extract files`.

Both failures happened at the *snapshot build* step (`Template.build`), which then blocked `Sandbox.create` → the session stuck at `starting` / `unreachable`.

---

## 2. Root Cause Analysis

### 2.1 Template tag mismatch

`apps/api/src/platform/providers/e2b.ts` called:

```ts
await Sandbox.create(`${templateName}:default`, …)
```

E2B templates are addressed by their **template ID** or **alias**, not by a `:tag` suffix. The literal tag `default` was never created on E2B, so every create 404'd.

**Fix:** `Sandbox.create(templateName, …)` — plain alias, no tag suffix.

### 2.2 envd auto-update crashes COPY extraction

E2B's build environment auto-updates the `envd` runtime ~2–3s into a build (observed `~T+2.7s`), taking ~15s. The build pipeline was:

```
COPY agent.gz → COPY cli.gz → COPY slack-cli/ → COPY executor-sdk/ → COPY scaffold.git → COPY opencode config → RUN gunzip + install → RUN slow deps
```

The `COPY` of directories (`slack-cli/`, `executor-sdk/`, `scaffold.git`, `kortix-opencode-config`) triggers E2B's archive-extraction path *during the envd update window* → `failed to extract files: exit status 2`. `RUN` instructions survive the update; the **COPY archive extraction does not**.

---

## 3. Fixes Applied

### 3.1 Staging (all providers, shared)

`apps/api/src/snapshots/build-context.ts` now stages **tarballs** instead of raw directories:

- `k-agent-v5.tar.gz` — gzipped `kortix-agent` binary
- `k-cli-v5.tar.gz` — gzipped `kortix` CLI
- `slack-cli-v5.tar.gz` — tarred slack-cli dir
- `executor-sdk-v5.tar.gz` — tarred executor-sdk dir
- `scaffold-v5.tar.gz` — tarred bare scaffold repo
- `kortix-llm-catalog.json` — full LLM model catalog (baked)
- `kortix-opencode-config/` — starter opencode config (best-effort)

New `assertContextComplete()` fail-loud guard verifies the context contains the files the Dockerfile COPYs (skips the checks when `e2bBaseImage` is set).

### 3.2 Dockerfile layer — the `sleep 20` fence

`apps/api/src/snapshots/dockerfile-layer.ts` (both the `e2bBaseImage` branch AND the normal `fastLayer`):

1. `COPY` **single tarballs** into `/opt/kortix/tmp/` — small, single-file COPYs finish well before the envd update fires.
2. `RUN sleep 20` — a **dedicated layer** that simply waits out the envd auto-update window (~15s). No file I/O, nothing to corrupt.
3. After the fence, a `RUN` does ALL extraction (`tar -xzf …`) + `install-shims.sh` + `kortix --version` verification — as a RUN, it survives the envd update.
4. `rm -rf /opt/kortix/tmp` cleans up; entrypoint/env still emitted after.

This is the key insight: **copy small files first, sleep out the envd update, extract in a RUN layer after.**

### 3.3 E2B adapter hardening

`apps/api/src/snapshots/providers/e2b.ts`:

- **Delete-before-build**: any existing template with the snapshot name is deleted before a new build (clears zombie/stale builds that cause E2B to cancel new ones).
- **No repo-dir staging**: removed the `.kortix-e2b-ctx/<name>` copy into the repo dir; builds use the temp context dir directly.
- `Template.build(…, { tags: ['default'], timeoutMs, requestTimeoutMs, onBuildLogs })` — tag applied **at build time** (not post-build `assignTags`, which got orphaned when E2B GC'd builds).
- `getSnapshotState` uses a raw `fetch('https://api.e2b.app/templates')` (with `X-API-Key`) instead of `Template.exists()` — returns `active`/`building`/`missing` from `buildStatus`, and **reaps errored templates** automatically.
- `waitForReady` now treats `failed to extract files`, `envd`, `exit status`, `cancelled`/`canceled`, `not found`, 502/503/504 as **transient** → keeps polling instead of failing fast. Build failures surface the E2B `reason.message` detail.

### 3.4 Provider defaults flipped to E2B

`apps/api/src/config.ts`, `apps/api/src/setup/index.ts`, `apps/api/src/snapshots/builder.ts`:

- `ALLOWED_SANDBOX_PROVIDERS` default: `daytona` → `e2b`
- `getDefaultProvider()` safety belt: `daytona` → `e2b`
- New `isE2BEnabled()` helper
- `reconcileStaleBuilds()` + `ensurePlatformDefaultImage()` use `config.getDefaultProvider()` (was hardcoded `daytona`)
- Debug logging in `ensureSandboxImage` for `[snapshots:debug]` tracing

### 3.5 Environment

- `E2B_BASE_IMAGE=ghcr.io/kageprime/sandbox-base:latest` in `apps/api/.env.local`, `apps/api/.env.prod`, `docker-compose.prod.yml`
- `ALLOWED_SANDBOX_PROVIDERS=e2b,daytona` (`.env.local`)
- `Dockerfile.base` rewritten to pre-bake Kortix infra (agent, CLI, slack-cli, executor-sdk, scaffold.git) — **NOTE: superseded by the tarball + sleep-20 approach; kept as a faster cold-start option but not required.**

---

## 4. Current State (2026-07-31)

### 4.1 Template builds: GREEN

E2B template `kortix-default-6f6bfc428c17` (alias) → template ID `kh3ts9qsah9b4055yyim` → **`buildStatus: ready`** on `api.e2b.app`. The envd crash is gone. Confirmed via `GET https://api.e2b.app/templates`.

### 4.2 Session provisioning: GREEN

Latest provision timeline (from `session_sandboxes` metadata):

```
row+tokens           202ms
image-built       64,697ms   (template build)
provider-create:1x  4,282ms   (Sandbox.create OK)
total              69,181ms
```

Sandbox rows flip to `status=active`, `initStatus=ready`. Provisioning itself no longer throws.

### 4.3 Open issues / follow-ups

1. **Runtime reachability on port 8000 is flaky.** `GET /v1/p/<ext>/8000/kortix/health` returns `502 sandbox upstream unreachable` for at least one active sandbox (`iqv2t20lyi8oqqwlpedq1`, row `c9caa997-…`). The template builds and the sandbox boots, but the in-sandbox daemon (port 8000) doesn't always answer. **This is the next thing to debug** — likely the entrypoint or the agent binary inside the sandbox.
2. **Zombie daemon polling from orphaned sandboxes.** Old E2B sandbox `iqy2rooj3y7xslenhdsc2` (pre-fix provision) is gone from E2B (404), but its daemon keeps polling `/v1/p/iqy2rooj3y7xslenhdsc2/8000/kortix/health` through the tunnel → **403 Not authorized** floods in API logs (~380/10min). Its DB row was re-provisioned to a new external id, so `resolveSandboxRef()` finds nothing → deny. Harmless but noisy; kill the old E2B sandbox if still alive, else ignore.
3. **E2B sandbox list is empty** (`GET /sandboxes` → `[]`) even though rows exist — **root cause confirmed: E2B GC'd the sandboxes after idle/pause.** `GET /v1/p/<ext>/8000/…` then fails `SandboxNotFoundError: Paused sandbox <id> not found` → proxy returns 502 (`sandbox upstream unreachable`) after 4 wake attempts. DB rows stay `active` and stale; a session reopen should re-provision fresh (the `Sandbox.connect` wake path can't resurrect a GC'd sandbox). Consider a reaper that marks rows `archived` when E2B reports `not found`.
4. **FIXED — the REAL root cause (2026-07-31): wrong SDK option keys.** The E2B SDK's `SandboxOpts` keys are `timeoutMs` and `envs` — the provider passed `timeout` and `envVars`, which are **silently dropped**. Consequences: every sandbox ran on E2B's **5-minute default TTL** (`timeout` ignored) and received **NO env vars** (`envVars` ignored — no KORTIX_SANDBOX_TOKEN/KORTIX_CLI_TOKEN inside the box). The 5-min TTL is why sandboxes vanished and `connect()` 404'd with `Paused sandbox … not found`; the missing envs were a second latent bomb. Fix: `timeoutMs` (ms, clamped to E2B's Hobby 1h max — Pro allows 24h; `400: Timeout cannot be greater than 1 hours` otherwise) + `envs`. Additionally `sandbox.getHost()` returns a **scheme-less hostname** (`8000-<id>.e2b.app`) which the preview proxy's `new URL()` rejects with `"… cannot be parsed as a URL"` → 502 — resolvePreviewLink/resolveEndpoint now prefix `https://`. And `Sandbox.list()` filters live under `query.metadata`, not `metadata` (listManagedRunningSandboxes was listing unfiltered). `getStatus()` returns `not_found` on `SandboxNotFoundError`; reaper + open/restart treat `not_found` like `removed` → reconcile to `stopped` + `needsReprovision`, so the next open reprovisions fresh. Verified end-to-end: sandbox TTL = 1h, envs present, `/v1/p/<ext>/8000/kortix/health` → `daemon:ok, runtimeReady:true`.

---

## 5. Key Files

| File | What changed |
|---|---|
| `apps/api/src/snapshots/dockerfile-layer.ts` | tarball COPYs + `sleep 20` fence + RUN extraction; both `e2bBaseImage` and normal paths |
| `apps/api/src/snapshots/build-context.ts` | tar staging for slack-cli/executor-sdk/scaffold; `assertContextComplete` |
| `apps/api/src/snapshots/providers/e2b.ts` | delete-before-build, raw-API `getSnapshotState`, transient-error retries, build tags |
| `apps/api/src/platform/providers/e2b.ts` | `Sandbox.create(templateName)` — no `:default` tag; **correct SDK keys `envs` + `timeoutMs`** (old `envVars`/`timeout` were silently dropped → 5-min TTL + no env); TTL clamped to 1h Hobby max; `getHost()` → `https://` scheme fix; `Sandbox.list({ query.metadata })`; `getStatus` → `not_found` on `SandboxNotFoundError`; `ensureRunning` throws on gone boxes |
| `apps/api/src/platform/providers/index.ts` | `SandboxStatus` gains `'not_found'` |
| `apps/api/src/projects/sandbox-reaper.ts` + `routes/shared.ts` + `session-lifecycle/actions.ts` | `not_found` treated like `removed` → reconcile to `stopped` + `needsReprovision`, reprovision on next open |
| `apps/api/src/snapshots/providers/e2b.ts` | import `getE2BApiKey`; drop invalid `timeoutMs` from `Template.build` (only `requestTimeoutMs` exists) |
| `apps/api/src/config.ts` | default provider `e2b`, `isE2BEnabled()` |
| `apps/api/src/setup/index.ts` | `/v1/setup` default provider string |
| `apps/api/src/snapshots/builder.ts` | use `getDefaultProvider()` in reconcile + platform-default image |
| `apps/api/src/__tests__/unit-e2b-adapter.test.ts` | fixed temp-path mock to `/tmp/ctx`, added `dockerfileName`/`composedPath` |

---

## 6. Verification Commands

```bash
# 1. E2B templates (expect buildStatus=ready for kortix-default-*)
curl -s https://api.e2b.app/templates -H "X-API-Key: $E2B_API_KEY"

# 2. Session sandbox rows (local supabase)
docker exec supabase_db_kortix-local psql -U postgres -d postgres -c \
  "select sandbox_id, external_id, status, provider, metadata->>'initStatus' from agentica.session_sandboxes order by updated_at desc limit 5;"

# 3. Proxy health through the tunnel (with the row's service key)
curl -s https://api.dosco.live/v1/p/<external_id>/8000/kortix/health \
  -H "X-Kortix-Token: kortix_sb_<serviceKey>"

# 4. API unit tests
cd apps/api && bun test src/__tests__/unit-e2b-adapter.test.ts
```

---

## 7. Lessons Learned

1. **E2B `envd` auto-updates mid-build (~T+2.7s, ~15s long).** Any COPY-based archive extraction in flight during the window dies with `failed to extract files`. Fence it: COPY small files → `RUN sleep 20` → extract in a RUN.
2. **E2B templates are addressed by alias/ID, not `:tag`.** Tag goes in `Template.build(tags: ['default'])`, never in `Sandbox.create`.
3. **Stale templates cancel new builds.** Always delete-then-build for the same snapshot name.
4. **`failed to extract files`, `envd`, `exit status`, `cancelled` are transient** during E2B builds — retry, don't fail.
5. **Verify end-to-end via the proxy** (`/v1/p/<ext>/8000/kortix/health` with the sandbox service key) — a `ready` template + `active` row does NOT mean the daemon answers on port 8000.
