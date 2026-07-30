/**
 * E2B sandbox provider — runtime lifecycle implementation.
 */

import { Sandbox } from 'e2b';
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

    const sandbox = await Sandbox.create(`${templateName}:default`, {
      envVars,
      timeout: (opts.autoStopInterval ?? 120) * 60, // minutes → seconds
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
        template,
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
    } catch {
      return 'unknown';
    }
  }

  async resolvePreviewLink(externalId: string, port: number): Promise<{ url: string; token: string | null }> {
    const sandbox = await Sandbox.connect(externalId);
    const url = sandbox.getHost(port);
    return { url, token: sandbox.trafficAccessToken ?? null };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const sandbox = await Sandbox.connect(externalId);
    const url = sandbox.getHost(8000);
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
    console.log(`[E2B] Sandbox ${externalId} is ${status}, waking up...`);
    await this.start(externalId);
  }

  async listManagedRunningSandboxes(): Promise<Array<{ externalId: string; createdAt: Date | null }>> {
    const out: Array<{ externalId: string; createdAt: Date | null }> = [];
    try {
      const paginator = Sandbox.list({
        metadata: {
          'kortix.managed': 'true',
          'kortix.env': config.INTERNAL_AGENTICA_ENV,
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
