# Project Memory

The **project brain** for `suna`. Auto-injected into every
agent's system prompt as a `<agentica-memory>` block. Sub-files below are
NOT auto-loaded — open them with `read` when relevant.

- [overview.md](overview.md) — what this project is, its purpose and shape
- [integrations.md](integrations.md) — third parties, MCP servers, channels, executor connectors
- [conventions.md](conventions.md) — patterns, naming, style, do / don't
- [decisions.md](decisions.md) — architectural and business choices worth not re-debating

Curated by the **memory-reflector** agent
(`.agentica/opencode/agents/memory-reflector.md`). To add or update
memory, load the **agentica-memory** skill.
