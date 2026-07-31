import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const cfg: { E2B_WEBHOOK_SECRET?: string; KORTIX_URL?: string } = {};
let configured = true;

mock.module('../../config', () => ({ config: cfg }));
mock.module('../../shared/e2b', () => ({
  getE2BApiKey: () => 'e2b-api-key-test',
  isE2BConfigured: () => configured,
}));

const { ensureE2BWebhookRegistered } = await import('./e2b-register');

const originalFetch = globalThis.fetch;
let listStatus: number;
let listBody: unknown;
let createStatus: number;
let lastCreateBody: string | null;
let fetchCalls: { url: string; init?: RequestInit }[];

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  cfg.E2B_WEBHOOK_SECRET = 'wh-secret-test';
  cfg.KORTIX_URL = 'https://api.dosco.live/';
  configured = true;
  listStatus = 200;
  listBody = [];
  createStatus = 201;
  lastCreateBody = null;
  fetchCalls = [];
  mockFetch(async (url, init) => {
    fetchCalls.push({ url, init });
    if (url.endsWith('/events/webhooks') && init?.method === 'POST') {
      lastCreateBody = String(init.body);
      return new Response('{}', { status: createStatus });
    }
    return new Response(JSON.stringify(listBody), { status: listStatus });
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ensureE2BWebhookRegistered', () => {
  test('registers the lifecycle webhook when none exists', async () => {
    const result = await ensureE2BWebhookRegistered();
    expect(result).toBe(true);
    const createCall = fetchCalls.find((c) => c.init?.method === 'POST');
    expect(createCall).toBeDefined();
    expect(createCall!.init?.headers).toEqual(expect.objectContaining({ 'X-API-Key': 'e2b-api-key-test' }));
    const body = JSON.parse(lastCreateBody!) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'kortix-sandbox-lifecycle',
      url: 'https://api.dosco.live/v1/webhooks/sandbox/e2b',
      enabled: true,
      events: ['sandbox.lifecycle.created', 'sandbox.lifecycle.updated', 'sandbox.lifecycle.killed'],
      signatureSecret: 'wh-secret-test',
    });
  });

  test('skips registration when a webhook with the same URL already exists', async () => {
    listBody = [{ url: 'https://api.dosco.live/v1/webhooks/sandbox/e2b' }];
    const result = await ensureE2BWebhookRegistered();
    expect(result).toBe(true);
    expect(fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  test('skips registration when a webhook with the same name already exists', async () => {
    listBody = [{ name: 'kortix-sandbox-lifecycle' }];
    const result = await ensureE2BWebhookRegistered();
    expect(result).toBe(true);
    expect(fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  test('never subscribes the paused event (transient under autoResume)', async () => {
    await ensureE2BWebhookRegistered();
    const events = (JSON.parse(lastCreateBody!) as { events: string[] }).events;
    expect(events).not.toContain('sandbox.lifecycle.paused');
  });

  test('reports false without throwing when E2B is not configured', async () => {
    configured = false;
    await expect(ensureE2BWebhookRegistered()).resolves.toBe(false);
  });

  test('reports false without throwing when the secret or callback base is missing', async () => {
    cfg.E2B_WEBHOOK_SECRET = undefined;
    await expect(ensureE2BWebhookRegistered()).resolves.toBe(false);
    cfg.E2B_WEBHOOK_SECRET = 'wh-secret-test';
    cfg.KORTIX_URL = '';
    await expect(ensureE2BWebhookRegistered()).resolves.toBe(false);
  });

  test('reports false without throwing on a failing list call', async () => {
    listStatus = 500;
    await expect(ensureE2BWebhookRegistered()).resolves.toBe(false);
  });

  test('reports false without throwing when register fails', async () => {
    createStatus = 400;
    await expect(ensureE2BWebhookRegistered()).resolves.toBe(false);
  });

  test('reports false without throwing when fetch rejects', async () => {
    mockFetch(async () => {
      throw new Error('network down');
    });
    await expect(ensureE2BWebhookRegistered()).resolves.toBe(false);
  });
});
