# OpenCode reference — overview

OpenCode is the agent runtime that powers every Agentica session. The
same `.agentica/opencode/` config dir drives both surfaces:

- **Remote** — when a Agentica session boots, the platform points OpenCode
  at this dir via `OPENCODE_CONFIG_DIR=.agentica/opencode` and launches
  the agent inside the sandbox VM.
- **Local** — when you (or anyone) runs `opencode` in this repo on
  their machine, the same config dir drives that session too.

So whatever you add here works in both places — no two parallel sets
of configs to keep in sync.

This folder mirrors the upstream OpenCode docs as standalone Markdown
files so an agent can read them without a network fetch. Pages are
canonical when they match upstream; if something here drifts, the
linked upstream page wins.

## Pages

| Topic                       | File             | Upstream                                                                          |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| Agents                      | `agents.md`      | <https://opencode.ai/docs/agents/>                                                |
| Skills                      | `skills.md`      | <https://opencode.ai/docs/skills/>                                                |
| Commands                    | `commands.md`    | <https://opencode.ai/docs/commands/>                                              |
| Tools (built-in + custom)   | `tools.md`       | <https://opencode.ai/docs/tools/> + <https://opencode.ai/docs/custom-tools/>      |
| Plugins                     | `plugins.md`     | <https://opencode.ai/docs/plugins/>                                               |
| MCP servers                 | `mcp-servers.md` | <https://opencode.ai/docs/mcp-servers/>                                           |
| Permissions                 | `permissions.md` | <https://opencode.ai/docs/permissions/>                                           |
| Rules (`AGENTS.md`)         | `rules.md`       | <https://opencode.ai/docs/rules/>                                                 |
| Models                      | `models.md`      | <https://opencode.ai/docs/models/>                                                |

## Where OpenCode looks for things in a Agentica project

OpenCode discovers its config from `OPENCODE_CONFIG_DIR`, which the
Agentica runtime sets to `.agentica/opencode/`. So everything below is
rooted there.

| Surface       | Path inside the Agentica project                                                              |
| ------------- | ------------------------------------------------------------------------------------------- |
| Config root   | `.agentica/opencode/opencode.jsonc`                                                           |
| Agents        | `.agentica/opencode/agents/<name>.md`                                                         |
| Skills        | `.agentica/opencode/skills/<name>/SKILL.md`                                                   |
| Commands      | `.agentica/opencode/commands/<name>.md`                                                       |
| Custom tools  | `.agentica/opencode/tools/<file>.ts`                                                          |
| Plugins       | `.agentica/opencode/plugins/<file>.ts` (+ `.agentica/opencode/package.json` for npm deps)       |
| MCP servers   | `.agentica/opencode/opencode.jsonc` → `mcp` key                                               |

## The contract with Agentica

OpenCode owns everything under `.agentica/opencode/`. The Agentica platform
never reads any of it — those files only matter to OpenCode itself.

Conversely, Agentica-specific config (triggers, secrets schema, sandbox
image, deployable apps, project metadata) lives in `agentica.toml` at
the repo root. OpenCode never reads `agentica.toml`.

Both halves are versioned in the same repo, but the boundary is
strict — see `../agentica/agentica-toml.md` for the Agentica half.
