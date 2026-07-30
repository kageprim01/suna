/**
 * E2B implementation of `SandboxProviderAdapter`.
 *
 * Wraps E2B SDK calls used by the snapshot system: build a template from a
 * composed Dockerfile, query its live state, and delete it.
 *
 * The "layered Dockerfile" composition is the caller's responsibility
 * (snapshots/builder.ts) — this adapter only knows about E2B-specific request
 * shapes and retries.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template, Sandbox } from 'e2b';
import { isE2BConfigured, deleteE2BTemplate } from '../../shared/e2b';
import { withTimeout } from '../../shared/with-timeout';
import {
  stageBuildContext,
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  KORTIX_ENTRYPOINT,
} from '../build-context';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_STATUS_POLL_MS = 3_000;
const BUILD_ATTEMPTS = 3;
const BUILD_RETRY_BASE_MS = 2_000;
const SNAPSHOT_LOG_TAIL_LIMIT = 20;
const ACTIVATE_DEADLINE_MS = 120_000;

/**
 * Positive-state cache for E2B templates. Keyed by template name; only
 * 'active' is cached. TTL is 60s — same rationale as the Daytona adapter.
 */
const SNAPSHOT_STATE_CACHE_TTL_MS = 60_000;
const SNAPSHOT_STATE_TIMEOUT_MS = 8_000;
const snapshotStateCache = new Map<string, { state: ProviderState; expiresAt: number }>();

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

class E2BAdapter implements SandboxProviderAdapter {
  readonly id = 'e2b' as const;

  isConfigured(): boolean {
    return isE2BConfigured();
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('E2BAdapter.buildSnapshot: neither image nor userDockerfile set');
    }

    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    const resources = {
      cpu: input.spec.cpu ?? DEFAULT_CPU,
      memory: input.spec.memoryGb ?? DEFAULT_MEMORY_GB,
    };
    console.info(
      `[snapshots] ${input.snapshotName}: building (slug="${input.slug}", provider=e2b, spec=${JSON.stringify(resources)})`,
    );

    let lastErr: unknown;
    for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
      const e2bBaseImage = process.env.E2B_BASE_IMAGE;
      const ctx = await stageBuildContext(input.snapshotName, userDockerfile, e2bBaseImage);
      const buildLogs: string[] = [];
      const relDir = `.kortix-e2b-ctx/${input.snapshotName}`;
      const absRelDir = join(_dirname, relDir);

      try {
        await rm(absRelDir, { recursive: true, force: true }).catch(() => {});
        await mkdir(absRelDir, { recursive: true });
        await cp(ctx.contextDir, absRelDir, { recursive: true });

        const dockerfilePath = join(absRelDir, ctx.dockerfileName);

        const template = Template({ fileContextPath: absRelDir })
          .fromDockerfile(dockerfilePath)
          .setEnvs(input.captureEnv ?? {});

        if (input.capture === 'stateful') {
          template.setStartCmd(
            input.entrypoint?.join(' ') ?? KORTIX_ENTRYPOINT,
            input.captureCondition?.http
              ? `curl http://localhost:${input.captureCondition.http.port}${input.captureCondition.http.path ?? '/health'}`
              : input.captureCondition?.cmd ?? 'true',
          );
        }

        const info = await Template.build(template, input.snapshotName, {
          cpuCount: resources.cpu,
          memoryMB: resources.memory * 1024,
          tags: ['default'],
          onBuildLogs: (logs) => {
            if (!Array.isArray(logs)) {
              console.warn(`[e2b] onBuildLogs received non-array: ${typeof logs} ${JSON.stringify(logs).slice(0, 100)}`);
              return;
            }
            for (const line of logs) {
              if (!line) continue;
              buildLogs.push(line);
              if (buildLogs.length > SNAPSHOT_LOG_TAIL_LIMIT) {
                buildLogs.splice(0, buildLogs.length - SNAPSHOT_LOG_TAIL_LIMIT);
              }
              console.info(`[snapshots] ${input.snapshotName}: ${line}`);
              tap?.onLine?.(line);
            }
          },
        });

        await this.waitForReady(info.templateId, info.buildId);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const errName = err instanceof Error ? err.name : typeof err;
        const errStack = err instanceof Error ? err.stack?.split('\n').slice(0, 6).join(' | ') : 'no-stack';
        console.error(`[e2b] build attempt ${attempt}/${BUILD_ATTEMPTS} failed: name=${errName} msg=${msg} stack=${errStack}`);
        if (!isRetryableBuildError(err) || attempt === BUILD_ATTEMPTS) {
          throw new Error(`Snapshot build failed: ${msg}`);
        }
        console.warn(
          `[snapshots] build attempt ${attempt}/${BUILD_ATTEMPTS} for ${input.snapshotName} failed — retrying: ${msg.slice(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, BUILD_RETRY_BASE_MS * attempt));
      } finally {
        await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
        await rm(absRelDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw lastErr;
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!isE2BConfigured()) return 'missing';

    const cached = snapshotStateCache.get(snapshotName);
    if (cached && Date.now() < cached.expiresAt) return cached.state;

    try {
      const exists = await withTimeout(
        Template.exists(snapshotName),
        SNAPSHOT_STATE_TIMEOUT_MS,
        `E2B Template.exists(${snapshotName})`,
      );
      const state: ProviderState = exists ? 'active' : 'missing';
      if (state === 'active') {
        snapshotStateCache.set(snapshotName, {
          state,
          expiresAt: Date.now() + SNAPSHOT_STATE_CACHE_TTL_MS,
        });
      } else {
        snapshotStateCache.delete(snapshotName);
      }
      return state;
    } catch {
      snapshotStateCache.delete(snapshotName);
      return 'missing';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!isE2BConfigured()) return;
    snapshotStateCache.delete(snapshotName);
    try {
      await deleteE2BTemplate(snapshotName);
    } catch {
      // treat as already gone
    }
  }

  private async waitForReady(templateId: string, buildId: string): Promise<void> {
    const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
    while (Date.now() < deadline) {
      try {
        const status = await Template.getBuildStatus(
          { templateId, buildId },
          { logsOffset: 0 },
        );
        if (status.status === 'ready') return;
        if (status.status === 'error') {
          throw new Error(`Template build failed: ${status.error ?? 'unknown error'}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('error') || msg.includes('failed')) throw err;
      }
      await new Promise((r) => setTimeout(r, BUILD_STATUS_POLL_MS));
    }
    throw new Error(`Template ${templateId} did not become ready after build (deadline exceeded)`);
  }
}

function isTransientE2BError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('eof') ||
    m.includes('network') ||
    m.includes('gateway') ||
    m.includes(' 502') ||
    m.includes(' 503') ||
    m.includes(' 504')
  );
}

function isRetryableBuildError(err: unknown): boolean {
  return isTransientE2BError(err);
}

export const e2bProvider = new E2BAdapter();
