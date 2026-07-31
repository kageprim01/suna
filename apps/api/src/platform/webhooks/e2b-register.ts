/**
 * E2B sandbox-lifecycle webhook registration.
 *
 * E2B delivers sandbox lifecycle events to a registered HTTP webhook
 * (docs/sandbox/lifecycle-events-webhooks.md). We subscribe so lifecycle
 * transitions (notably `killed`) reconcile the sandbox/session rows the
 * instant E2B reports them, instead of up to a reaper sweep-interval later.
 *
 * Deliberately NOT subscribed: `sandbox.lifecycle.paused` — with the
 * `onTimeout: 'pause' + autoResume: true` lifecycle (see platform/providers/
 * e2b.ts) pauses are transient (the box auto-resumes on the next request), so
 * a paused event must NOT flip the session to `stopped`. `created`/`updated`
 * are subscribed as audit no-ops.
 *
 * Registration is idempotent (GET → find by name/url → POST only when absent)
 * and best-effort: failure logs and never throws — the reaper stays the
 * correctness backstop, webhooks are a latency upgrade.
 */

import { config } from '../../config';
import { getE2BApiKey, isE2BConfigured } from '../../shared/e2b';

const E2B_API_BASE = 'https://api.e2b.app';
const WEBHOOK_NAME = 'kortix-sandbox-lifecycle';

const SUBSCRIBED_EVENTS = [
  'sandbox.lifecycle.created',
  'sandbox.lifecycle.updated',
  'sandbox.lifecycle.killed',
] as const;

export async function ensureE2BWebhookRegistered(): Promise<boolean> {
  if (!isE2BConfigured()) {
    console.warn('[e2b-webhooks] skipped: E2B not configured');
    return false;
  }
  const secret = config.E2B_WEBHOOK_SECRET;
  const base = (config.KORTIX_URL ?? '').replace(/\/+$/, '');
  if (!secret || !base) {
    console.warn('[e2b-webhooks] skipped: E2B_WEBHOOK_SECRET and/or KORTIX_URL not set');
    return false;
  }

  const url = `${base}/v1/webhooks/sandbox/e2b`;
  const keyHeaders = { 'X-API-Key': getE2BApiKey() };

  try {
    const listRes = await fetch(`${E2B_API_BASE}/events/webhooks`, { headers: keyHeaders });
    if (!listRes.ok) {
      console.warn(`[e2b-webhooks] list failed: HTTP ${listRes.status}`);
      return false;
    }
    const body = (await listRes.json()) as unknown;
    const existing = Array.isArray(body) ? body : ((body as { webhooks?: unknown[] })?.webhooks ?? []);
    if (existing.some((w) => (w as { url?: string; name?: string })?.url === url || (w as { name?: string })?.name === WEBHOOK_NAME)) {
      console.log('[e2b-webhooks] already registered — skipping');
      return true;
    }

    const createRes = await fetch(`${E2B_API_BASE}/events/webhooks`, {
      method: 'POST',
      headers: { ...keyHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: WEBHOOK_NAME,
        url,
        enabled: true,
        events: SUBSCRIBED_EVENTS,
        signatureSecret: secret,
      }),
    });
    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => '');
      console.warn(`[e2b-webhooks] register failed: HTTP ${createRes.status} ${detail.slice(0, 200)}`);
      return false;
    }
    console.log(`[e2b-webhooks] registered → ${url}`);
    return true;
  } catch (err) {
    console.warn('[e2b-webhooks] registration error:', err instanceof Error ? err.message : err);
    return false;
  }
}
