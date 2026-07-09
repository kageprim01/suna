# Agentica CLI — full reference

The `agentica` CLI is the canonical way to drive everything the Agentica
dashboard can do — from a terminal, from a coding agent, from a session
sandbox. It is **always available** inside a Agentica session sandbox:

- the binary is on `PATH` (`/usr/local/bin/agentica`)
- `AGENTICA_CLI_TOKEN` is pre-injected — a project-scoped token the CLI
  authenticates with automatically (not `AGENTICA_TOKEN`; see "Inside a
  sandbox" below)
- `AGENTICA_API_URL` points at the platform you're running against

So you can run `agentica sessions ls` or `agentica secrets set FOO=bar`
from any shell in the sandbox with no setup.

This document lives under the `agentica-system` skill at
`.agentica/opencode/skills/agentica-system/references/agentica/agentica-cli.md`
— it travels with your repo and is loaded on-demand whenever an agent
needs CLI specifics.

## Quickstart inside a session

```sh
agentica whoami                       # confirms what project + account this token has
agentica projects info                # the project you're running inside
agentica secrets ls                   # encrypted env vars + manifest [env] spec
agentica sessions ls                  # every session on this project (incl. you)
agentica cr ls                        # open change requests
agentica cr open --title "..."        # propose merging your branch into main
```

The token in the sandbox is **project-scoped**: it can read + write
anything on *this* project (secrets, sessions, triggers, change
requests, apps), but it cannot list other projects or touch
account-level resources. See "Token scope" below for the full
permission model.

## On your laptop

The local install flow is one curl + one click:

```sh
curl -fsSL https://agentica.com/install | bash
agentica login                        # opens browser, you click Authorize
```

The local CLI uses a **user-scoped** token saved at
`~/.config/agentica/config.json` (mode 0600). That token can see every
project on every account you're a member of.

## Command surface

### Machine-readable output (`--json`) — driving Agentica as an agent

Every **read/list** command accepts `--json`: it prints the raw API
payload to **stdout** (the human table is suppressed) and nothing else,
so an agent can parse it directly. All diagnostics — the `host …` banner,
update notices, errors — go to **stderr**, so `… --json 2>/dev/null | jq`
is always clean JSON. Mutations are flag-driven with no hidden prompts.

Net effect: the CLI is a **100% scriptable surface** — an agent can drive
Agentica end-to-end from the terminal, the same surface a human drives in
the dashboard (list/select/interact with sessions, read messages, browse
files & diffs, open/merge change requests, manage secrets/triggers/
connectors, …).

```sh
agentica sessions ls --json                       # what's running
agentica sessions log <id> --json                 # what an agent is doing
agentica cr ls --json                             # open change requests
agentica files cat README.md --json | jq -r .content
```

### Auth

| Command | Effect |
| --- | --- |
| `agentica login [--token <pat>] [--host <name>] [--api <url>]` | Default: opens browser → click Authorize → token written. `--token` is the headless fallback. `--host` logs into a named host slot (see Hosts). |
| `agentica logout [--host <name>]` | Remove the token for the active host (or named one). |
| `agentica whoami [--host <name>]` | Print the user + active account on the chosen host. |

### Hosts — pick which Agentica you talk to

A host is one Agentica API endpoint. You can configure several
(cloud, localhost, self-hosted) and switch between them. One is
"active" at any moment; commands operate on the active host by default.

| Command | Effect |
| --- | --- |
| `agentica hosts ls` | List configured hosts (`●` marks active). |
| `agentica hosts use [<name>]` | Switch active host. No name → arrow-key picker. |
| `agentica hosts add <name> --url <url> [--login]` | Register a new host. `--login` runs the browser flow right after. |
| `agentica hosts rm <name>` | Remove a host (confirms when it's the last one). |
| `agentica hosts info [<name>]` | Detailed view of one host. |
| `agentica hosts current` | Print the active host name (script-friendly). |

`--host <name>` on any command overrides the active host for a single
invocation: `agentica projects ls --host local`.

### Projects

| Command | Effect |
| --- | --- |
| `agentica projects ls` | Every project on the active account. |
| `agentica projects info [<id-or-slug>]` | Show one project (defaults to the linked one — see below). |
| `agentica projects link [<id>]` | Bind cwd to a remote project. Writes `.agentica/link.json` with `project_id`, `account_id`, `host`, `host_url`. No arg → arrow-key picker. |
| `agentica projects unlink` | Drop `.agentica/link.json`. |
| `agentica projects open [<id>]` | Open the dashboard URL for a project in your browser. |

#### How a command finds "the project"

In strict order:

1. `--project <id>` flag.
2. `AGENTICA_PROJECT_ID` env var.
3. `.agentica/link.json` in cwd (or any ancestor — git-style).
4. Inside a session sandbox: the sandbox's own `AGENTICA_PROJECT_ID`.

If none resolve, the command errors with a pointer to `projects link`.

#### How a command finds "the host"

1. `--host <name>` flag.
2. `host` field in `.agentica/link.json` (so a repo always hits its
   home Agentica instance).
3. The globally-active host.

### Secrets

Encrypted env vars stored on the project, injected as plain env
into every session sandbox at boot.

| Command | Effect |
| --- | --- |
| `agentica secrets ls` | List secret names + manifest `[env]` spec; marks required-but-missing. |
| `agentica secrets set NAME=VALUE …` | Upsert one or more. `NAME=-` reads VALUE from stdin (so values never appear in shell history). |
| `agentica secrets request NAME …` | **Mint a short-lived link for a human to ENTER the value(s)** — you never see/handle the raw key. Surface the URL (web: fill-in modal, Slack: tappable link). `--scope runtime\|connector` (default `runtime` = injected into the sandbox env), `--expires <minutes>` (default 30). Use this when you need a key you don't have. |
| `agentica secrets unset NAME …` | Remove. |

> **Asking a human for a secret.** You usually don't *have* the value, so don't
> use `set`. Run `agentica secrets request APOLLO_API_KEY` (or the `request_secret`
> tool on the `agentica-executor` MCP), surface the returned URL, end your turn, and
> when they say "done" confirm with `agentica secrets ls`. See the
> **credentials-and-setup-links** reference.

### Executor — call connectors as tools

The Executor is the one interface to every configured integration (Pipedream /
MCP / OpenAPI / GraphQL / HTTP). Calls run **server-side** through the gateway —
no third-party secret ever touches the sandbox. It has three faces over one
core: the `agentica-executor` **MCP** (primary; auto-loaded), this **CLI**, and the
`@kortix/executor-sdk` **TypeScript framework**. JSON output.

| Command | Effect |
| --- | --- |
| `agentica executor connectors` | List connectors + tools this session can use. |
| `agentica executor discover "<intent>"` | Search tools by natural language (`--limit`). |
| `agentica executor describe <connector>.<action>` | Show one tool's input schema + risk. |
| `agentica executor call <connector> <action> '<json>'` | Run a tool (gateway resolves the credential, enforces policy, audits). |
| `agentica executor add <slug> --provider pipedream --app <app>` | Add a connector NOW (no CR) — commits to `agentica.toml` on main + syncs. |
| `agentica executor rm <slug>` | Remove a connector. |
| `agentica executor connect <slug>` | Mint a Pipedream Quick Connect link to hand the human. |
| `agentica executor mcp` | Run the Executor as a stdio MCP server (opencode auto-loads this). |

> Inside a session, **prefer the `agentica-executor` MCP tools** (`connectors` /
> `discover` / `describe` / `call`) — they're always loaded. The CLI is the same
> core for shell/scripting use.

### Env — dotenv ↔ secrets

| Command | Effect |
| --- | --- |
| `agentica env pull [--out .env] [--force]` | Write a `.env` skeleton (names only — plaintext can't leave the cloud). |
| `agentica env push --from <path>` | Upload every `NAME=VALUE` from a dotenv file as a secret. Supports quoted values, `export NAME=…`, comment lines. |

### Sessions

Each session is an isolated sandbox VM on its own ephemeral branch.

| Command | Effect |
| --- | --- |
| `agentica sessions ls` | All sessions on the project. `--json` for machine-readable output. |
| `agentica sessions status [--all] [--json]` | **Mission control** — every session + what each agent is doing *right now* (live: current tool / thinking / idle + last activity). Built for when many run in parallel. Aliases: `overview`, `ps`. |
| `agentica sessions info <id>` | Detail view: status, branch, base ref, agent, sandbox URL, errors. `--json`. |
| `agentica sessions log [<id>] [--limit N] [--json]` | **Read-only** peek at a session agent's recent messages — see what another agent is *doing right now* without sending it anything. Aliases: `messages`, `history`. No id → most-recent running (an interactive picker when several run on a TTY). |
| `agentica sessions chat [<id>]` | Talk to a session's agent. `--prompt "<text>"` = one-shot (prints the reply and exits); add `--json` to get that reply as JSON (a synchronous subagent call); no flag = REPL. No id → picks/asks which running session. `--new` starts a fresh one. |
| `agentica sessions new [--prompt "<text>"] [--wait] [--json]` | Start a new session. `--wait` blocks until it's running; `--json` prints the session object so you can capture `session_id` to orchestrate. |
| `agentica sessions restart <id>` | Re-provision a session in place. |
| `agentica sessions rm <id>` | Stop + delete. |
| `agentica sessions open <id>` | Open the dashboard URL for a session. |

**Inside a sandbox:** `AGENTICA_SESSION_ID` tells you which session
you're running in. `agentica sessions info $AGENTICA_SESSION_ID` gives
you the live view of yourself.

**Watch + talk to other agents.** From any session (or your laptop) you
can see the whole project's activity and read it live — this is how an
agent checks up on every other agent that's running:

```sh
agentica sessions status                      # all agents + what each is doing now
agentica sessions status --json | jq .        # …parsed for a monitoring loop
agentica sessions log <id> --limit 20         # read one agent's recent transcript
agentica sessions chat <id> --prompt "…"      # talk to another agent
```

`log` is **read-only** — it never sends a message, so it's the safe way
to observe. To actually talk to another session, one-shot it:
`agentica sessions chat <id> --prompt "status?"` (prints the reply and
exits), or drop into a REPL with `agentica sessions chat <id>`.

**Orchestrate parallel subagents.** The whole fan-out loop is CLI-only —
spawn many sessions, watch the fleet, collect results, land work:

```sh
# spawn a subagent and get a *ready* session id back in one call
id=$(agentica sessions new --json --wait --prompt "do task X" | jq -r .session_id)

agentica sessions status --json                 # the fleet: who's working vs idle
agentica sessions chat "$id" --prompt "result?" --json | jq -r .text   # synchronous call
agentica sessions log "$id" --json              # …or read progress without interrupting

agentica cr ls --json                           # subagents land work as CRs → review/merge
agentica sessions rm "$id"                       # tear the subagent down
```

`--json --wait` is the spawn primitive (one call → a running session id you
can immediately drive); `sessions status` is the at-a-glance fleet view;
`chat … --prompt --json` is a synchronous call; `log` is async observation.

### Triggers

Round-trip through `agentica.toml`'s `[[triggers]]`. Dashboard sees
the same state.

| Command | Effect |
| --- | --- |
| `agentica triggers ls` | List triggers + runtime state (`last_fired_at`). |
| `agentica triggers info <slug>` | Show one trigger in full. |
| `agentica triggers fire <slug>` | Manually fire a trigger now. |
| `agentica triggers enable <slug>` | Set `enabled = true`. |
| `agentica triggers disable <slug>` | Set `enabled = false`. |

### Change requests (`cr`)

Agentica-native PR layer for session work landing on `main`. A change
request proposes merging one branch (`head_ref`) into another
(`base_ref`) inside a project. The CR layer is **Agentica-native** —
it works on top of any git host (GitHub, GitLab, Freestyle, plain
git) without per-host integration. A CR is the **only sanctioned
way** for an agent to land session-branch work on `main`; see
`change-requests.md` (alongside this file) for the full mandate and
lifecycle.

| Command | Effect |
| --- | --- |
| `agentica cr ls [--status open\|merged\|closed\|all] [--project <id>]` | List CRs on the project. Default: `--status open`. |
| `agentica cr show <cr> [--project <id>]` | Show one CR's metadata. Alias: `agentica cr info`. Includes the merge-preview (clean / fast-forward / conflicts) for open CRs. |
| `agentica cr diff <cr> [--no-color] [--project <id>]` | Unified diff of the CR. Three-dot diff for open / closed CRs; for merged CRs it uses the SHAs captured at merge time so the patch still renders even though `head_ref` is now reachable from `base_ref`. |
| `agentica cr open --title "<text>" [--description "<text>"] [--head <ref>] [--base <ref>] [--session <id>] [--project <id>]` | Open a new CR. Aliases: `agentica cr new`, `agentica cr create`. Inside a sandbox, `--head` defaults to `$AGENTICA_BRANCH_NAME` and `--session` defaults to `$AGENTICA_SESSION_ID`, so `agentica cr open --title "..."` Just Works. `--base` defaults to the project's default branch (usually `main`). `--title` is required. Alias for `--head`: `--from`. Alias for `--base`: `--into`. Alias for `--description`: `--body`. |
| `agentica cr merge <cr> [--message "<text>"] [--project <id>]` | Merge an open CR into its `base_ref`. Fast-forward when possible, three-way merge otherwise. The default commit message is `Merge CR #<n>: <title>` (override with `-m / --message`). Fails with 409 if the CR is not `open` or there are conflicts. |
| `agentica cr close <cr> [--project <id>]` | Close an open CR without merging. Cannot close a merged CR. |
| `agentica cr reopen <cr> [--project <id>]` | Reopen a closed CR (only — merged CRs are terminal). |

`<cr>` accepts either the short per-project number (`3`, `#3`) or the
full UUID `cr_id`. Numbers are unique per project, monotonically
increasing.

#### Inside a sandbox — the typical agent flow

```sh
# 1. Commit on the session branch
git add .
git commit -m "Add release-notes skill"

# 2. Push the branch (AGENTICA_BRANCH_NAME)
git push origin HEAD

# 3. Open the CR — head and session are auto-detected
agentica cr open \
  --title  "Add release-notes skill" \
  --description "Drafts release notes from merged commits. Tested against the last 5 tags."

# 4. Confirm it's listed
agentica cr ls

# 5. (Optional) show the diff one more time
agentica cr diff 3
```

The agent **does not merge its own CR** — that's the user's call,
either in the dashboard or via `agentica cr merge <n>`.

#### Conflicts

`agentica cr show <cr>` prints a merge preview:

- `Mergeable cleanly` — no conflicts; `agentica cr merge` will succeed.
- `Mergeable cleanly (fast-forward)` — `head_ref` is strictly ahead of
  `base_ref`; the merge will be a fast-forward.
- `Conflicts in N files:` — listed; resolve on the branch first, push,
  then re-show.

#### Output format

`agentica cr ls` prints `#NUM`, status badge (`● open` / `✔ merged` /
`× closed`), `head_ref → base_ref` (truncated UUID-style branches),
title. Sorted newest first.

#### Exit codes

| Code | Meaning |
| --- | --- |
| `0`  | Success. |
| `1`  | Operation failed (CR not found, merge failed, etc.). |
| `2`  | Bad flag / missing required arg. |

> See `change-requests.md` (alongside this file) for the full
> data model, REST API, and the "MUST open a CR" agent mandate.

### Install / update / uninstall

| Command | Effect |
| --- | --- |
| `agentica update` | Re-runs `curl -fsSL agentica.com/install | bash` to pull the latest binary. |
| `agentica uninstall` | Removes the binary, /usr/local/bin shim, and `~/.config/agentica/`. `--keep-auth` keeps the token. |
| `agentica version` | Print the CLI version. |

### Project scaffold

| Command | Effect |
| --- | --- |
| `agentica init` | Scaffold a Agentica project in the current directory. Writes `agentica.toml`, `.agentica/Dockerfile`, the OpenCode config dir with the default agent + agentica-system skill, and a `.agentica/link.json` placeholder. Then, for each coding agent you select (opencode/claude/codex/cursor), symlinks the OpenCode config dir into that agent's native location (`.opencode` / `.claude` → `.agentica/opencode`; codex wires `.agents` → `.agentica/opencode`, its documented cross-tool skills dir) so they share its skills + agents; Codex and Cursor also get a root `AGENTS.md` pointer they read natively (so Cursor needs no rule file). Note: Claude scans `.claude/skills` only one level deep, so skills nested under a grouping folder aren't discovered by Claude locally (they still load in the OpenCode sandbox and for Codex). |
| `agentica <project-name>` | Same as `init` but creates a new directory next to cwd. |

## Token scope

There are **two** token types issued by the Agentica API. Both use the
`agentica_pat_…` prefix; they're distinguished by an internal `project_id`
column on the token row.

| Type | Scope | Issued by | Typical use |
| --- | --- | --- | --- |
| **User token** | All projects on accounts the user belongs to + account-level routes (`/v1/accounts/me`, billing, etc.) | `agentica login` browser flow → minted via `POST /v1/accounts/tokens` | The CLI on your laptop |
| **Project token** | Read + write everything on **one** project — secrets, sessions, triggers, change requests, apps. Cannot list other projects or hit account-level routes. | Auto-minted at session create; surfaced via `POST /v1/projects/:id/cli-token` | The CLI inside a sandbox |

Enforcement: every project route handler checks the token's
`project_id` against the URL's `:projectId` parameter. Mismatch → 403.
Account routes (`/v1/accounts/*`) reject any project-scoped token
outright.

### Inside a sandbox

The session bootstrap injects:

```
AGENTICA_CLI_TOKEN=agentica_pat_…   ← project-scoped PAT; what the CLI authenticates with
AGENTICA_TOKEN=agentica_sb_…        ← sandbox service key (runtime/clone/LLM) — NOT for the CLI
AGENTICA_API_URL=https://<host>/v1
AGENTICA_PROJECT_ID=<uuid>
AGENTICA_SESSION_ID=<uuid>
AGENTICA_BRANCH_NAME=<session-branch>
```

The CLI reads `AGENTICA_CLI_TOKEN` (falling back to `AGENTICA_EXECUTOR_TOKEN`)
automatically and uses `AGENTICA_API_URL` as the host base. No config file,
no `agentica login` needed — `agentica …` just works.

> **Don't authenticate with `AGENTICA_TOKEN`.** That's the sandbox *service
> key* (used for the LLM gateway, the tool router, and just-in-time git
> clone credentials). The project-scoped routes the CLI calls
> (`change-requests`, `secrets`, …) reject it with `401 Invalid or expired
> token` — it isn't expired, it's simply the wrong token. Use the CLI; it
> already holds the right one.

### Rotating

```sh
# From a logged-in user CLI:
agentica projects info                    # confirm you're on the right project
agentica project token rotate             # rotates the project token
# (existing sandboxes keep their token until they restart)
```

## Common workflows

### Spin up a fresh session with custom env

```sh
agentica secrets set OPENAI_API_KEY=sk-… ANTHROPIC_API_KEY=sk-…
agentica sessions new --prompt "Audit the auth module and propose a fix"
```

### Inside a session: trigger another session

```sh
# I'm an agent that just finished a big migration. Spawn a verifier:
agentica sessions new --prompt "Verify migration 0048 by running pnpm test + opening a CR if anything fails"
```

### Run a trigger by hand for debugging

```sh
agentica triggers ls                      # confirm the slug + status
agentica triggers fire daily-digest       # one-shot manual fire
agentica sessions ls | head -3            # the new session that the trigger spawned
```

### Pull current secrets into a local `.env` for development

```sh
agentica env pull                         # names only, values left blank
$EDITOR .env                            # fill in values locally
# (don't push — local-only file)
```

### Bulk-upload local `.env` to the cloud project

```sh
agentica env push --from .env
agentica secrets ls                       # confirm
```

### Land session work on `main` (the CR flow)

The agent in the sandbox is responsible for opening the CR; the user
reviews + merges. **There is no other path to `main` from inside a
session.**

```sh
# inside a session sandbox, on branch session-<id>
git add .
git commit -m "Add release-notes skill"
git push origin HEAD

agentica cr open \
  --title       "Add release-notes skill" \
  --description "Drafts release notes from merged commits. Tested against the last 5 tags."

agentica cr ls                            # confirm
```

The user can then:

```sh
agentica cr show 3                        # diff + merge-preview
agentica cr diff 3
agentica cr merge 3                       # merges into base (main)
# or
agentica cr close 3                       # close without merging
```

See `change-requests.md` next to this file for the full lifecycle,
conflict story, and data model.

## Environment variables the CLI reads

| Variable | Purpose |
| --- | --- |
| `AGENTICA_CLI_TOKEN` | Project-scoped PAT the CLI authenticates with (injected in sandboxes). |
| `AGENTICA_EXECUTOR_TOKEN` | Same PAT under another name; the CLI falls back to it. |
| `AGENTICA_TOKEN` | Sandbox **service key** — runtime/clone/LLM auth. **Not** a CLI token; project routes reject it. |
| `AGENTICA_API_URL` | API base URL. In a sandbox it already includes the `/v1` mount. |
| `AGENTICA_PROJECT_ID` | Override the linked project for one command. |
| `AGENTICA_CONFIG_FILE` | Override `~/.config/agentica/config.json` location (useful for tests). |
| `AGENTICA_DASHBOARD_URL` | Override the dashboard URL the `login` flow opens (default: derived from API URL). |

The `AGENTICA_*` env-var prefix is **reserved** for platform-injected
values. Don't declare your own project secrets with that prefix —
the secrets-manager API rejects them, and the manifest validator
warns.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Operation failed (API error, missing project, etc.). Diagnostics printed to stderr. |
| `2` | Bad flag, unknown subcommand, missing required arg. |

## What the CLI is not

- **Not a self-host installer.** That legacy lives at the old
  `~/.agentica/agentica` bash script; this binary is the cloud-native
  replacement. If you self-host, `agentica login --api http://…` still
  works against your instance — just point it at your own URL.
- **Not a `git` replacement.** `agentica cr` is the change-request
  surface; it composes with `git` rather than wrapping it.
- **Not the runtime.** The thing executing the agent in the sandbox is
  OpenCode. The CLI is the *control plane* — start sessions, manage
  secrets, fire triggers, review CRs. See the OpenCode reference
  files alongside this one for what runs *inside* a session.

## See also

- `.agentica/opencode/skills/agentica-system/SKILL.md` — entry point for
  the agentica-system skill. Mention the CLI from there.
- `change-requests.md` (alongside this file) — full CR data model,
  lifecycle, REST API, and the "MUST open a CR" agent mandate.
- `agentica.toml` — the manifest the dashboard + the CLI both read.
- `.agentica/Dockerfile` — your sandbox base image.
- `.agentica/link.json` — current dir's binding to a remote project
  (project_id + host).
