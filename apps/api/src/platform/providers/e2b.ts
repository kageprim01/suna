/**
 * E2B sandbox provider — runtime lifecycle implementation.
 */

import { Sandbox, SandboxNotFoundError } from 'e2b';
import { getE2BApiKey, isE2BConfigured } from '../../shared/e2b';
import { serviceKeyForExternalId } from '../service-key';
import { sandboxFrontendBaseUrl } from '../sandbox-frontend-url';
import { config, SANDBOX_VERSION } from '../../config';
import type {
  SandboxProvider,
  ProviderName,
  CreateSandboxOpts,
  ProvisionResult,
  SandboxStatus,
  ResolvedEndpoint,
  ProvisioningTraits,
  ProvisioningStatus,
} from './index';

const STATUS_CACHE_TTL_MS = 1500;
const runningStatusCache = new Map<string, number>(); // externalId → cachedAt (ms)

function isE2BNotFound(err: unknown): boolean {
  return err instanceof SandboxNotFoundError ||
    (err instanceof Error && err.name === 'SandboxNotFoundError');
}

export class E2BProvider implements SandboxProvider {
  readonly name: ProviderName = 'e2b';

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [
      { id: 'creating', progress: 50, message: 'Creating sandbox...' },
    ],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');

    const envVars: Record<string, string> = {
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
      ...opts.envVars,
    };

    if (!envVars.KORTIX_TOKEN) {
      throw new Error('[e2b] create() called without KORTIX_TOKEN — sandbox cannot authenticate to the Kortix router.');
    }

    const templateName = opts.snapshot;
    if (!templateName) {
      throw new Error(
        'E2B create() called without opts.snapshot. ' +
        'Every sandbox must boot from a per-project template built by ' +
        'apps/api/src/snapshots/builder.ts. There is no shared fallback.',
      );
    }

    const sandbox = await Sandbox.create(templateName, {
      // NOTE: the SDK's SandboxOpts keys are `envs` and `timeoutMs` — `envVars`
      // / `timeout` are NOT valid keys and are silently DROPPED (caught
      // 2026-07-31: sandbox came up with E2B's 300s default TTL and no env).
      envs: envVars,
      // `timeoutMs` is a HARD max lifetime (TTL in ms), not an idle timer: when
      // it fires the sandbox is killed and later GC'd — `connect()` on a GC'd
      // box 404s with "Paused sandbox … not found", which left sessions
      // unreachable ~5 min after provision (the pre-fix `timeout:` key was
      // ignored, so EVERY box ran on E2B's 5-minute default — the real reason
      // sandboxes kept vanishing). Kortix owns the lifecycle: the API explicitly
      // pauses on session stop / kills on session delete, so the provider-side
      // TTL only needs to be a generous ceiling. E2B enforces a per-plan max —
      // Pro: 24h, Hobby: 1h (`400: Timeout cannot be greater than 1 hours`,
      // caught 2026-07-31). Use the Hobby-safe 1h default; an explicit
      // autoStopInterval (minutes) is honored (clamped to the same 1h ceiling,
      // which also covers warm-pool `autoStopInterval: 0` → persistent intent,
      // since E2B has no infinite TTL).
      timeoutMs: Math.min(
        (opts.autoStopInterval && opts.autoStopInterval > 0 ? opts.autoStopInterval : 60),
        60,
      ) * 60 * 1000, // minutes → ms, clamped to the 1h Hobby max
      metadata: {
        'kortix.managed': 'true',
        'kortix.env': config.INTERNAL_AGENTICA_ENV,
      },
    });

    const externalId = sandbox.sandboxId;
    const baseUrl = `${sandboxApiBase}/v1/p/${externalId}/8000`;

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        e2bSandboxId: externalId,
        template: templateName,
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    // E2B connect() auto-resumes a paused sandbox.
    await Sandbox.connect(externalId);
  }

  async stop(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    await Sandbox.pause(externalId);
  }

  async remove(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    await Sandbox.kill(externalId);
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    const cachedAt = runningStatusCache.get(externalId);
    if (cachedAt !== undefined && Date.now() - cachedAt < STATUS_CACHE_TTL_MS) {
      return 'running';
    }

    try {
      const info = await Sandbox.getInfo(externalId);
      const state = (info.state ?? '').toLowerCase();
      if (state === 'running') {
        runningStatusCache.set(externalId, Date.now());
        return 'running';
      }
      runningStatusCache.delete(externalId);
      if (state === 'paused') return 'stopped';
      return 'unknown';
    } catch (err) {
      // SandboxNotFoundError (404): E2B killed + GC'd the box — its TTL expired
      // or it was deleted out-of-band. This is NOT "unknown/alive", it is
      // "gone": keep the cache cleared so every caller re-checks, and surface
      // the distinction so the session layer can reprovision instead of
      // parking the session on a dead external id.
      if (isE2BNotFound(err)) {
        runningStatusCache.delete(externalId);
        console.warn(`[E2B] sandbox ${externalId} no longer exists on E2B (killed/GC'd) — treating as not-found`);
        return 'not_found';
      }
      return 'unknown';
    }
  }

  async resolvePreviewLink(externalId: string, port: number): Promise<{ url: string; token: string | null }> {
    const sandbox = await Sandbox.connect(externalId);
    // getHost() returns a bare hostname ("8000-<id>.e2b.app") — no scheme —
    // which the proxy's new URL()/fetch rejects ("cannot be parsed as a URL").
    // Normalize to a full https URL here so /v1/p/ works for E2B sandboxes.
    const host = sandbox.getHost(port);
    const url = /^https?:\/\//.test(host) ? host : `https://${host}`;
    return { url, token: sandbox.trafficAccessToken ?? null };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const sandbox = await Sandbox.connect(externalId);
    // Same scheme normalization as resolvePreviewLink — getHost() is scheme-less.
    const host = sandbox.getHost(8000);
    const url = /^https?:\/\//.test(host) ? host : `https://${host}`;
    const token = sandbox.trafficAccessToken ?? null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { 'X-E2B-Traffic-Access-Token': token } : {}),
    };

    try {
      const serviceKey = await serviceKeyForExternalId(externalId);
      if (serviceKey) {
        headers['Authorization'] = `Bearer ${serviceKey}`;
      }
    } catch (err) {
      console.warn(`[E2B] Failed to look up service key for ${externalId}:`, err);
    }

    return { url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    if (status === 'not_found') {
      throw new SandboxNotFoundError(
        `E2B sandbox ${externalId} no longer exists (killed/GC'd) — reprovision required`,
      );
    }
    console.log(`[E2B] Sandbox ${externalId} is ${status}, waking up...`);
    await this.start(externalId);
  }

  async listManagedRunningSandboxes(): Promise<Array<{ externalId: string; createdAt: Date | null }>> {
    const out: Array<{ externalId: string; createdAt: Date | null }> = [];
    try {
      const paginator = Sandbox.list({
        query: {
          metadata: {
            'kortix.managed': 'true',
            'kortix.env': config.INTERNAL_AGENTICA_ENV,
          },
        },
      });
      while (paginator.hasNext) {
        const items = await paginator.nextItems();
        for (const item of items) {
          out.push({
            externalId: item.sandboxId,
            createdAt: item.startedAt ?? null,
          });
        }
      }
    } catch (err) {
      console.warn('[E2B] listManagedRunningSandboxes failed:', err instanceof Error ? err.message : err);
    }
    return out;
  }
}
