/**
 * Compose the layered Dockerfile that becomes a session sandbox image.
 *
 * The user's Dockerfile defines whatever workspace they want (language
 * toolchains, system packages, seed data). We append a final stage that
 * makes the result *connectable* by the Kortix dashboard:
 *
 *   1. apt-get install ca-certificates curl git nodejs npm
 *   2. npm install -g opencode-ai@<pinned-version>
 *   3. COPY the kortix-agent + kortix-entrypoint binaries to /usr/local/bin
 *   4. ENV KORTIX_WORKSPACE=/workspace, WORKDIR /workspace, EXPOSE 8000
 *   5. ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
 *
 * The project workspace is NOT baked in — the daemon git-clones it at boot
 * via `KORTIX_PROJECT_AUTO_CLONE`. That keeps the image identity decoupled
 * from project source code, so a code change never invalidates a snapshot
 * and most projects share a single global default image.
 *
 * Steps 1-2 require apt (Debian/Ubuntu family base). Step 5 means the
 * user's ENTRYPOINT is always overridden — see docs/dockerfile.mdx for
 * the user-facing constraint list.
 */

/**
 * Default pinned `agent-browser` (Vercel agent-browser) CLI version baked into
 * the layer when the caller doesn't pin one explicitly. The builder may pass an
 * override via `agentBrowserVersion` to centralize the pin (and fold it into the
 * snapshot fingerprint); this fallback keeps the layer self-contained.
 */
const DEFAULT_AGENT_BROWSER_VERSION = '0.27.0';

/**
 * Chromium source for `agent-browser`. agent-browser's own `install` fetches
 * Chrome for Testing, which has NO linux-arm64 build — so we source Chromium
 * from Playwright instead: it ships both linux-x64 AND linux-arm64, and
 * `--with-deps` installs the OS libraries Chromium needs. Keep in sync with the
 * pin in apps/sandbox/Dockerfile + apps/api/src/snapshots/warm-bake.ts, and bump
 * RUNTIME_LAYER_VERSION in templates.ts when this changes so cached images
 * rebuild (the rendered Dockerfile text is not itself part of the fingerprint).
 */
const PLAYWRIGHT_VERSION = '1.60.0';

/**
 * Hardcoded "platform default" Dockerfile. Used when a session boots from
 * Kortix's default template — no user customization, just Ubuntu plus the
 * Kortix runtime layer on top. The workspace gets cloned at boot.
 *
 * This is fed into `buildLayeredDockerfile` like any other user Dockerfile.
 * Exposed so the snapshot identity hash treats it as a stable input.
 */
export const PLATFORM_DEFAULT_USER_DOCKERFILE = [
  '# syntax=docker/dockerfile:1.7',
  '# Kortix platform default sandbox base.',
  '# Sessions clone the project workspace at boot — nothing project-specific',
  '# is baked in here. Customize via `[[sandbox.templates]]` in kortix.toml.',
  'FROM ubuntu:24.04',
  '',
  'WORKDIR /workspace',
  '',
].join('\n') + '\n';

export interface BuildLayeredDockerfileOpts {
  /** Literal contents of the user's project Dockerfile. */
  userDockerfile: string;
  /** Pinned opencode CLI version (matches platform-wide `OPENCODE_VERSION`). */
  opencodeVersion: string;
  /**
   * Pinned `agent-browser` CLI version. Optional — defaults to
   * `DEFAULT_AGENT_BROWSER_VERSION`. The builder passes the platform-wide
   * `AGENT_BROWSER_VERSION` so the pin is centralized and fingerprinted.
   */
  agentBrowserVersion?: string;
  /** Path the snapshot builder will reference for the gzipped kortix-agent binary. */
  agentBinaryPath: string;
  /**
   * Path the snapshot builder will reference for the gzipped `kortix` CLI
   * binary. This is the admin CLI every in-sandbox agent reaches for
   * (`kortix cr open`, `secrets`, `sessions`, …); it lands on PATH as
   * `/usr/local/bin/kortix`, pre-authenticated via the injected
   * KORTIX_CLI_TOKEN. Always provided by the production builder.
   */
  cliBinaryPath: string;
  /** Path the snapshot builder will reference for the entrypoint script. */
  entrypointScriptPath: string;
  /**
   * Path the snapshot builder will reference for the slack-cli source tree
   * (apps/sandbox/slack-cli). The layer COPYs it into
   * /opt/kortix/apps/sandbox/slack-cli
   * and runs install-shims.sh to wire each *.ts (excluding lib/) as a
   * /usr/local/bin/<name> shim — that's how `slack` lands on PATH for the
   * agent to invoke from inside the sandbox. (The Executor moved into the
   * `kortix` CLI as `kortix executor` / `kortix executor mcp`.)
   */
  slackCliPath: string;
  /**
   * Path the snapshot builder will reference for packages/executor-sdk.
   * The agent CLI imports it via the same repo-relative path in dev and in
   * real snapshots.
   */
  executorSdkPath: string;
  /**
   * Path (in the build context) to the canonical starter `.kortix/opencode`
   * config tree (pty plugin + standard tools + skills). When provided, the
   * layer warms a real opencode PROJECT INSTANCE against it at build time so the
   * costly first-instance work (Bun plugin auto-install/transpile, models.dev
   * fetch, ripgrep) is cached into the image instead of paid on the session hot
   * path. Optional — omit to skip the instance warm-up.
   */
  opencodeConfigPath?: string;
  /**
   * Path (in the build context) to the baked full gateway model catalog JSON.
   * COPY'd into the image so the no-restart warm seed — which has no sandbox
   * token / projectId to fetch the catalog at PARK — gets the full model picker
   * instead of the daemon's minimal fallback. Optional; omit to skip.
   */
  catalogPath?: string;
  /**
   * When set, the output Dockerfile uses `FROM <e2bBaseImage>` instead of the
   * user's FROM and OMITS all heavy RUN commands (apt, npm, bun, playwright).
   * Only COPYs, gunzip, metadata, and the opencode warm-up RUN are emitted.
   * This eliminates all COPY-heavy archive extraction during the build, which
   * prevents the E2B envd auto-update crash.
   */
  e2bBaseImage?: string;
}

export function buildLayeredDockerfile(opts: BuildLayeredDockerfileOpts): string {
  const {
    userDockerfile,
    opencodeVersion,
    agentBrowserVersion = DEFAULT_AGENT_BROWSER_VERSION,
    agentBinaryPath,
    cliBinaryPath,
    entrypointScriptPath,
    slackCliPath,
    executorSdkPath,
    opencodeConfigPath,
    catalogPath,
    e2bBaseImage,
  } = opts;
  const trimmed = normalizeUserDockerfileForSnapshot(userDockerfile).trimEnd();

  // ── Phase 1: COPYs + metadata (fast — completes before E2B envd timer) ──
  // All COPY instructions, gunzip, and metadata-only instructions are placed
  // BEFORE any slow RUN commands. On E2B the platform's envd auto-update fires
  // at ~T+2.7s into any build — if COPYs haven't completed by then the build
  // crashes with "failed to extract files". These fast instructions finish in
  // < 1.5s, safely before the timer. Slow RUN commands (apt, npm, bun, …)
  // survive the envd update because RUN instructions don't trigger the archive
  // extraction path that crashes.
  //
  // When `e2bBaseImage` is set, the FROM is replaced with a pre-baked base
  // image that already contains all heavy deps, and the entire slowLayer is
  // skipped. Only the COPYs + gunzip + metadata + warump-up RUN are emitted.
  // When `e2bBaseImage` is set to a pre-baked base that already contains
  // the agent binary, CLI, slack-cli, executor-sdk, and scaffold.git, we
  // skip the infrastructure COPYs and gunzip step — they're already in the
  // base image. Only the opencode starter config (user project overlay) and
  // the workspace setup are emitted.
  if (e2bBaseImage) {
    const fromReplaced = trimmed.replace(/^FROM\s+\S+/im, `FROM ${e2bBaseImage}`);
    const agentCopies = [
      '',
      'USER root',
      ...(opencodeConfigPath ? [`COPY ${opencodeConfigPath}/ /opt/kortix/warm-config/.kortix/opencode/`] : []),
      `COPY ${agentBinaryPath} /opt/kortix/tmp/k-agent-v5.tar.gz`,
      `COPY ${cliBinaryPath} /opt/kortix/tmp/k-cli-v5.tar.gz`,
      `COPY ${entrypointScriptPath} /usr/local/bin/kortix-entrypoint`,
      `COPY slack-cli-v5.tar.gz /opt/kortix/tmp/slack-cli-v5.tar.gz`,
      `COPY executor-sdk-v5.tar.gz /opt/kortix/tmp/executor-sdk-v5.tar.gz`,
      ...(catalogPath ? [`COPY ${catalogPath} /opt/kortix/llm-catalog.json`] : []),
      `COPY scaffold-v5.tar.gz /opt/kortix/tmp/scaffold-v5.tar.gz`,
      '# Wait for E2B envd auto-update to finish before doing any file I/O.',
      '# The update fires ~2-3s into the build and takes ~15s; sleeping 20s',
      '# in a dedicated layer guarantees it completes before extraction.',
      'RUN sleep 20',
      'RUN mkdir -p /opt/kortix/apps/sandbox/slack-cli /opt/kortix/packages/executor-sdk /opt/kortix/scaffold.git \\',
      '    && tar -xzf /opt/kortix/tmp/k-agent-v5.tar.gz -C /usr/local/bin \\',
      '    && tar -xzf /opt/kortix/tmp/k-cli-v5.tar.gz -C /usr/local/bin \\',
      '    && tar -xzf /opt/kortix/tmp/slack-cli-v5.tar.gz -C /opt/kortix/apps/sandbox/slack-cli \\',
      '    && tar -xzf /opt/kortix/tmp/executor-sdk-v5.tar.gz -C /opt/kortix/packages/executor-sdk \\',
      '    && tar -xzf /opt/kortix/tmp/scaffold-v5.tar.gz -C /opt/kortix/scaffold.git \\',
      '    && rm -rf /opt/kortix/tmp \\',
      '    && chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint \\',
      '        /opt/kortix/apps/sandbox/slack-cli/install-shims.sh \\',
      '    && bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \\',
      '    && kortix --version',
    ];
    const warmUp: string[] = [];
    return `${fromReplaced}\n${agentCopies.join('\n')}\n${warmUp.join('\n')}ENV KORTIX_WORKSPACE=/workspace\nRUN mkdir -p /workspace\nWORKDIR /workspace\nEXPOSE 8000\nENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]\n`;
  }

  const fastLayer = [
    '',
    '# ─── Agentica app layer (fast — COPYs, gunzip, metadata) ────────────',
    '# Everything below is added by the Agentica snapshot builder. Do not',
    "# edit by hand — your project Dockerfile above is preserved verbatim.",
    '',
    'USER root',
    // opencode starter config (conditional)
    ...(opencodeConfigPath ? [`COPY ${opencodeConfigPath}/ /opt/kortix/warm-config/.kortix/opencode/`] : []),
    `COPY ${agentBinaryPath} /opt/kortix/tmp/k-agent-v5.tar.gz`,
    `COPY ${cliBinaryPath} /opt/kortix/tmp/k-cli-v5.tar.gz`,
    `COPY ${entrypointScriptPath} /usr/local/bin/kortix-entrypoint`,
    `COPY slack-cli-v5.tar.gz /opt/kortix/tmp/slack-cli-v5.tar.gz`,
    `COPY executor-sdk-v5.tar.gz /opt/kortix/tmp/executor-sdk-v5.tar.gz`,
    ...(catalogPath ? [`COPY ${catalogPath} /opt/kortix/llm-catalog.json`] : []),
    `COPY scaffold-v5.tar.gz /opt/kortix/tmp/scaffold-v5.tar.gz`,
    '# Wait for E2B envd auto-update to finish before doing any file I/O.',
    '# The update fires ~2-3s into the build and takes ~15s; sleeping 20s',
    '# in a dedicated layer guarantees it completes before extraction.',
    'RUN sleep 20',
    'RUN mkdir -p /opt/kortix/apps/sandbox/slack-cli /opt/kortix/packages/executor-sdk /opt/kortix/scaffold.git \\',
    '    && tar -xzf /opt/kortix/tmp/k-agent-v5.tar.gz -C /usr/local/bin \\',
    '    && tar -xzf /opt/kortix/tmp/k-cli-v5.tar.gz -C /usr/local/bin \\',
    '    && tar -xzf /opt/kortix/tmp/slack-cli-v5.tar.gz -C /opt/kortix/apps/sandbox/slack-cli \\',
    '    && tar -xzf /opt/kortix/tmp/executor-sdk-v5.tar.gz -C /opt/kortix/packages/executor-sdk \\',
    '    && tar -xzf /opt/kortix/tmp/scaffold-v5.tar.gz -C /opt/kortix/scaffold.git \\',
    '    && rm -rf /opt/kortix/tmp \\',
    '    && chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint \\',
    '        /opt/kortix/apps/sandbox/slack-cli/install-shims.sh \\',
    '    && bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \\',
    '    && kortix --version',
    '',
    'ENV KORTIX_WORKSPACE=/workspace',
    'RUN mkdir -p /workspace /opt/kortix/home /ephemeral/kortix-master/opencode',
    'WORKDIR /workspace',
    'EXPOSE 8000',
    'ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]',
    '',
  ];

  // ── Phase 2: Runtime deps (slow RUNs — survive E2B envd update) ──────
  // These are heavy RUN commands (apt-get, npm, bun, agent-browser). They
  // execute AFTER all COPYs have completed. E2B's envd auto-update may fire
  // during these — but RUN instructions are safe; only COPY archive extraction
  // crashes under the envd update.
  const slowLayer = [
    '',
    '# ─── Agentica runtime layer (slow RUN commands) ────────────────────',
    '# These are RUN commands that do heavy lifting (apt, npm, bun,',
    '# agent-browser, opencode warm-up). They run AFTER all COPY instructions',
    "# so that E2B's envd auto-update doesn't corrupt COPY archive extraction.",
    '',
    'RUN apt-get update \\',
    '    && apt-get install -y --no-install-recommends \\',
    '        ca-certificates curl git gzip nodejs npm unzip tmux iproute2 iputils-arping \\',
    '    && rm -rf /var/lib/apt/lists/*',
    '',
    `RUN npm install -g --no-audit --no-fund "opencode-ai@${opencodeVersion}" \\`,
    '    && command -v opencode \\',
    '    && opencode --version',
    '',
    // Bake OpenCode's "one time database migration" at BUILD time.
    'RUN set +e; \\',
    '    export HOME=/opt/kortix/home \\',
    '        XDG_DATA_HOME=/opt/kortix/home/.local/share \\',
    '        XDG_CONFIG_HOME=/opt/kortix/home/.config \\',
    '        XDG_CACHE_HOME=/opt/kortix/home/.cache; \\',
    '    mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"; \\',
    '    opencode serve --port 4096 --hostname 127.0.0.1 >/tmp/oc-bake.log 2>&1 & oc_pid=$!; \\',
    '    for i in $(seq 1 180); do \\',
    '        curl -s -o /dev/null -m 2 http://127.0.0.1:4096/ && break; \\',
    '        kill -0 "$oc_pid" 2>/dev/null || break; \\',
    '        sleep 1; \\',
    '    done; \\',
    '    sleep 3; \\',
    '    kill "$oc_pid" 2>/dev/null; wait "$oc_pid" 2>/dev/null; \\',
    '    echo "=== migration-bake: opencode data dir ==="; ls -laR "$XDG_DATA_HOME/opencode" 2>/dev/null | head -40; \\',
    '    echo "=== migration-bake: opencode log tail ==="; tail -25 /tmp/oc-bake.log; \\',
    '    rm -f /tmp/oc-bake.log; true',
    '',
    // bun runtime for the agent CLIs + `kortix executor mcp`.
    'RUN curl -fsSL https://bun.sh/install | bash \\',
    '    && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \\',
    '    && bun --version',
    '',
    // Pre-install OpenCode tool deps once, at image-build time.
    'RUN mkdir -p /opt/kortix/home/.bun/install/cache /opt/kortix/opencode-config-deps \\',
    '    && cd /opt/kortix/opencode-config-deps \\',
    `    && printf '{"name":"kortix-opencode-config","private":true,"dependencies":{"@mendable/firecrawl-js":"^4.25.1","@tavily/core":"^0.7.3","replicate":"^1.4.0"}}' > package.json \\`,
    '    && HOME=/opt/kortix/home BUN_INSTALL_CACHE_DIR=/opt/kortix/home/.bun/install/cache bun install',
    '',
    // agent-browser + Playwright Chromium
    'ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \\',
    '    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium \\',
    '    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage',
    `RUN npm install -g --no-audit --no-fund "agent-browser@${agentBrowserVersion}" \\`,
    '    && agent-browser --version \\',
    `    && HOME=/opt/kortix/home npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \\`,
    '    && rm -rf /var/lib/apt/lists/* \\',
    `    && pw_chrome="$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)" \\`,
    '    && test -n "$pw_chrome" \\',
    '    && ln -sf "$pw_chrome" /usr/local/bin/chromium \\',
    '    && mkdir -p /opt/kortix/home/.agent-browser/browsers \\',
    '    && ln -sf "$(dirname "$pw_chrome")" /opt/kortix/home/.agent-browser/browsers/chrome-linux64 \\',
    '    && /usr/local/bin/chromium --version \\',
    "    && env -u AGENT_BROWSER_EXECUTABLE_PATH HOME=/opt/kortix/home agent-browser doctor 2>&1 | grep -qE 'pass.+chrome-linux64/chrome'",
    '',
    // Warm a real opencode PROJECT INSTANCE at build time.
    ...(opencodeConfigPath
      ? [
          'RUN set +e; \\',
          '    export HOME=/opt/kortix/home \\',
          '        XDG_DATA_HOME=/opt/kortix/home/.local/share \\',
          '        XDG_CONFIG_HOME=/opt/kortix/home/.config \\',
          '        XDG_CACHE_HOME=/opt/kortix/home/.cache \\',
          '        BUN_INSTALL_CACHE_DIR=/opt/kortix/home/.bun/install/cache; \\',
          '    mkdir -p /workspace/.kortix; \\',
          '    cp -a /opt/kortix/warm-config/.kortix/opencode /workspace/.kortix/opencode; \\',
          '    rm -rf /workspace/.kortix/opencode/node_modules; \\',
          '    ln -s /opt/kortix/opencode-config-deps/node_modules /workspace/.kortix/opencode/node_modules; \\',
          '    export OPENCODE_CONFIG_DIR=/workspace/.kortix/opencode; \\',
          '    cd /workspace; \\',
          '    opencode serve --port 4096 --hostname 127.0.0.1 >/tmp/oc-warm.log 2>&1 & oc_pid=$!; \\',
          '    ready=0; \\',
          '    for i in $(seq 1 300); do \\',
          `        code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:4096/session?directory=/workspace" 2>/dev/null); \\`,
          '        case "$code" in 200|204|301|302) ready=1; break;; esac; \\',
          '        kill -0 "$oc_pid" 2>/dev/null || break; \\',
          '        sleep 1; \\',
          '    done; \\',
          '    echo "=== instance-warm: ready=$ready ==="; \\',
          '    kill "$oc_pid" 2>/dev/null; wait "$oc_pid" 2>/dev/null; \\',
          '    find /workspace -mindepth 1 -delete 2>/dev/null; \\',
          '    rm -rf /opt/kortix/warm-config; \\',
          '    echo "=== instance-warm: opencode log tail ==="; tail -20 /tmp/oc-warm.log; \\',
          '    rm -f /tmp/oc-warm.log; true',
          '',
        ]
      : []),
    '',
  ];

  if (e2bBaseImage) {
    // E2B base image mode: FROM the pre-baked base (already has all heavy
    // deps), replace the user's FROM, and only emit COPYs + gunzip + metadata
    // + opencode warm-up. The slowLayer (apt, npm, bun, playwright) is SKIPPED
    // — it's baked into the base image.
    const fromReplaced = trimmed.replace(/^FROM\s+\S+/im, `FROM ${e2bBaseImage}`);
    const warmUp: string[] = [];
    return `${fromReplaced}\n${fastLayer.join('\n')}${warmUp.join('\n')}`;
  }

  return `${trimmed}\n${fastLayer.join('\n')}\n${slowLayer.join('\n')}`;
}

export function normalizeUserDockerfileForSnapshot(dockerfile: string): string {
  // The legacy starter Dockerfile installed baseline tools that the injected
  // Kortix layer installs again. Strip that exact starter block so existing
  // user Dockerfiles still build cleanly.
  const starterBlock =
    /# Bring in baseline tooling\. The Kortix layer on top also installs\n# git\/curl\/ca-certificates\/nodejs\/npm, but having them in your base\n# makes interactive sessions snappier\.\nRUN apt-get update \\\n    && apt-get install -y --no-install-recommends \\\n        ca-certificates \\\n        curl \\\n        git \\\n        build-essential \\\n    && rm -rf \/var\/lib\/apt\/lists\/\*\n\n?/;
  return dockerfile.replace(starterBlock, '');
}

/**
 * A sandbox template defines one bootable image. Projects can declare multiple
 * via `[[sandbox.templates]]` in kortix.toml; sessions pick one by slug. The platform
 * default template is always available without any config.
 */
export interface SandboxTemplate {
  /** Stable identifier the session creator references. Unique per project. */
  slug: string;
  /** Display label shown in the dashboard picker. Optional. */
  name?: string;
  /**
   * Repo-relative path to a Dockerfile. The builder reads its bytes and layers
   * the Agentica runtime on top. Mutually exclusive with `image`.
   */
  dockerfile?: string;
  /**
   * Public Docker image reference (e.g. `python:3.12-slim`). The builder
   * generates a tiny `FROM <image>` shim and layers the Agentica runtime on top.
   * Mutually exclusive with `dockerfile`.
   */
  image?: string;
  /** Hardware spec (cpu/memory/disk). GPUs are intentionally not supported. */
  spec: SandboxSpec;
  /**
   * True iff this is the platform default (no user customization). Never
   * declared in kortix.toml — the platform synthesizes one of these.
   */
  isDefault?: boolean;
}

/** Reserved slug for the platform-provided default template. */
export const DEFAULT_SANDBOX_SLUG = 'default';

/**
 * Build the canonical platform default template. Always available, identity
 * derived purely from the platform runtime fingerprint — every project on the
 * same Kortix release shares one image.
 */
export function buildDefaultSandboxTemplate(spec: SandboxSpec = {}): SandboxTemplate {
  return {
    slug: DEFAULT_SANDBOX_SLUG,
    name: 'Default',
    spec,
    isDefault: true,
  };
}

/**
 * Hardware spec for the sandbox, read from `[[sandbox.templates]]` entries in
 * kortix.toml. Fields map onto Daytona's snapshot `Resources` (vCPU cores,
 * memory & disk in GiB). GPU is intentionally omitted. Every field is
 * optional; an unset field uses the platform default.
 */
export interface SandboxSpec {
  /** vCPU cores. */
  cpu?: number;
  /** Memory in GiB. */
  memory?: number;
  /** Disk in GiB. */
  disk?: number;
}

/**
 * Defensive bounds for each spec field. A value below `min` is dropped and
 * the platform default is used; a value above `max` is clamped to `max`.
 */
export const SANDBOX_SPEC_LIMITS = {
  cpu: { min: 1, max: 32 },
  memory: { min: 1, max: 128 }, // GiB
  disk: { min: 1, max: 500 }, // GiB
} as const;

function pickResource(value: unknown, bounds: { min: number; max: number }): number | undefined {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (n === undefined || !Number.isFinite(n)) return undefined;
  n = Math.round(n);
  if (n < bounds.min) return undefined;
  if (n > bounds.max) n = bounds.max;
  return n;
}

function extractSpecFromRow(row: Record<string, unknown>): SandboxSpec {
  const spec: SandboxSpec = {};
  const cpu = pickResource(row.cpu ?? row.cpus, SANDBOX_SPEC_LIMITS.cpu);
  const memory = pickResource(row.memory ?? row.memory_gb ?? row.mem, SANDBOX_SPEC_LIMITS.memory);
  const disk = pickResource(row.disk ?? row.disk_gb, SANDBOX_SPEC_LIMITS.disk);
  if (cpu !== undefined) spec.cpu = cpu;
  if (memory !== undefined) spec.memory = memory;
  if (disk !== undefined) spec.disk = disk;
  return spec;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Parse `[[sandbox.templates]]` from a parsed manifest. Returns the
 * user-declared templates in declaration order. The platform default is NOT
 * included here; callers always add it themselves so it can't be shadowed by
 * a misnamed slug.
 *
 * The slug `default` is reserved for the platform-shared template — any
 * `[[sandbox.templates]]` entry that tries to claim it is dropped with a warning.
 *
 * Malformed entries are skipped (logged) so a broken table can't take down
 * session boot for the rest of the project.
 */
export function extractSandboxTemplates(
  manifestRaw: Record<string, unknown> | null | undefined,
): SandboxTemplate[] {
  if (!manifestRaw) return [];
  const out: SandboxTemplate[] = [];
  const seenSlugs = new Set<string>();

  // [[sandbox.templates]] = array of tables (parses to sandbox.templates).
  const sandbox = manifestRaw.sandbox;
  const nested =
    sandbox && typeof sandbox === 'object' && !Array.isArray(sandbox)
      ? (sandbox as Record<string, unknown>).templates
      : undefined;
  // Migration safety net: the pre-rename `[[sandboxes]]` form still parses at
  // boot so an un-migrated project on main doesn't lose its templates. The
  // validator (ship / CR-merge gate) is what enforces the new name.
  const arr = Array.isArray(nested) ? nested : manifestRaw.sandboxes;
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const tpl = parseSandboxTemplate(row);
      if (!tpl) continue;
      if (tpl.slug === DEFAULT_SANDBOX_SLUG) {
        console.warn(`[sandbox-templates] slug "default" is reserved — skipping entry`);
        continue;
      }
      if (seenSlugs.has(tpl.slug)) {
        console.warn(`[sandbox-templates] duplicate slug "${tpl.slug}" — keeping first`);
        continue;
      }
      seenSlugs.add(tpl.slug);
      out.push(tpl);
    }
  }

  return out;
}

/**
 * Read `[sandbox] default` — the project-wide default template slug that every
 * session boots when the caller doesn't pass an explicit `sandbox_slug`.
 * Returns null when unset (→ the platform default image). The reserved
 * "default" is treated as "no override" since it IS the platform default.
 */
export function extractSandboxDefault(
  manifestRaw: Record<string, unknown> | null | undefined,
): string | null {
  const sandbox = manifestRaw?.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return null;
  const raw = (sandbox as Record<string, unknown>).default;
  const slug = typeof raw === 'string' ? raw.trim() : '';
  if (!slug || slug === DEFAULT_SANDBOX_SLUG || !SLUG_RE.test(slug)) return null;
  return slug;
}

function parseSandboxTemplate(row: Record<string, unknown>): SandboxTemplate | null {
  const slugRaw = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slugRaw || !SLUG_RE.test(slugRaw)) {
    console.warn(`[sandbox-templates] entry missing or invalid slug, skipped:`, row);
    return null;
  }
  const dockerfile = typeof row.dockerfile === 'string' ? row.dockerfile.trim() : '';
  const image = typeof row.image === 'string' ? row.image.trim() : '';
  if (dockerfile && image) {
    console.warn(`[sandbox-templates] "${slugRaw}" sets both dockerfile and image — keeping dockerfile`);
  }
  const spec = extractSpecFromRow(row);
  const name = typeof row.name === 'string' ? row.name.trim() : undefined;
  const sanitizedDockerfile = dockerfile ? sanitizeRelPath(dockerfile) : '';
  return {
    slug: slugRaw,
    name: name || undefined,
    dockerfile: sanitizedDockerfile || undefined,
    image: !sanitizedDockerfile && image ? image : undefined,
    spec,
  };
}

function sanitizeRelPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return '';
  if (trimmed.split('/').includes('..')) return '';
  return trimmed;
}
