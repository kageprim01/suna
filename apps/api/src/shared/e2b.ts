/**
 * E2B SDK client singleton + helpers.
 *
 * The E2B SDK auto-reads E2B_API_KEY from the environment — no explicit client
 * instantiation is needed. Most operations use static methods on the Sandbox
 * and Template classes.
 */

import { Sandbox, Template } from 'e2b';
import { config } from '../config';

export { Sandbox, Template };

export function getE2BApiKey(): string {
  if (!config.E2B_API_KEY) {
    throw new Error('Missing E2B_API_KEY');
  }
  return config.E2B_API_KEY;
}

export function isE2BConfigured(): boolean {
  return !!config.E2B_API_KEY;
}

const E2B_API_BASE = 'https://api.e2b.app';

/**
 * Delete an E2B template by name via the REST API.
 * The SDK does not expose template deletion directly.
 */
export async function deleteE2BTemplate(templateName: string): Promise<void> {
  const res = await fetch(`${E2B_API_BASE}/templates/${encodeURIComponent(templateName)}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': getE2BApiKey() },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`E2B template delete failed: HTTP ${res.status}`);
  }
}

/**
 * List E2B templates in the org. Used by snapshot reconciliation to detect
 * orphans and enforce quotas.
 */
export async function listE2BTemplates(): Promise<Array<{ name: string; templateId: string; createdAt: string | null }>> {
  const res = await fetch(`${E2B_API_BASE}/templates`, {
    headers: { 'X-API-Key': getE2BApiKey() },
  });
  if (!res.ok) {
    throw new Error(`E2B list templates failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    templates?: Array<{ name: string; template_id: string; created_at?: string }>;
  };
  return (body.templates ?? []).map((t) => ({
    name: t.name,
    templateId: t.template_id,
    createdAt: t.created_at ?? null,
  }));
}
