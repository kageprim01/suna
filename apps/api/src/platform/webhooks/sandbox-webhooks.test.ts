import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';

const cfg: { DAYTONA_WEBHOOK_SECRET?: string; PLATINUM_WEBHOOK_SECRET?: string; E2B_WEBHOOK_SECRET?: string } = {};
let stoppedCalls: string[] = [];
let removedCalls: string[] = [];
let dedupSeen: Set<string> = new Set();

mock.module('../../config', () => ({ config: cfg }));
mock.module('../../billing/services/webhook-concurrency', () => ({
  recordWebhookEvent: async (id: string) => {
    if (dedupSeen.has(id)) return false;
    dedupSeen.add(id);
    return true;
  },
}));
mock.module('../../projects/sandbox-reaper', () => ({
  reconcileSandboxStoppedByExternalId: async (externalId: string) => {
    stoppedCalls.push(externalId);
    return true;
  },
  reconcileSandboxRemovedByExternalId: async (externalId: string) => {
    removedCalls.push(externalId);
    return true;
  },
}));

const {
  classifyLifecycle,
  verifyHmacSha256,
  verifySvix,
  verifyE2B,
  handleDaytonaWebhook,
  handlePlatinumWebhook,
  handleE2BWebhook,
} = await import('./sandbox-webhooks');

beforeEach(() => {
  cfg.DAYTONA_WEBHOOK_SECRET = undefined;
  cfg.PLATINUM_WEBHOOK_SECRET = undefined;
  cfg.E2B_WEBHOOK_SECRET = undefined;
  stoppedCalls = [];
  removedCalls = [];
  dedupSeen = new Set();
});

describe('classifyLifecycle', () => {
  test('terminal states → stopped', () => {
    for (const s of ['stopped', 'stopping', 'archived', 'archiving']) {
      expect(classifyLifecycle(s, 'sandbox.state.updated')).toBe('stopped');
    }
  });
  test('destroyed/deleted/lost or delete event → removed', () => {
    expect(classifyLifecycle('deleted', 'x')).toBe('removed');
    expect(classifyLifecycle('lost', 'x')).toBe('removed');
    expect(classifyLifecycle(undefined, 'sandbox.deleted')).toBe('removed');
  });
  test('started/running/creating → noop', () => {
    for (const s of ['started', 'running', 'creating', 'resuming']) {
      expect(classifyLifecycle(s, 'sandbox.state.updated')).toBe('noop');
    }
  });
});

describe('verifyHmacSha256 (Platinum)', () => {
  const secret = 'whsec_platinum_test';
  const body = '{"id":"sb1","state":"stopped"}';
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  test('accepts a correct hex signature', () => {
    expect(verifyHmacSha256(body, secret, sig)).toBe(true);
  });
  test('accepts sha256= / v1= prefixed', () => {
    expect(verifyHmacSha256(body, secret, `sha256=${sig}`)).toBe(true);
    expect(verifyHmacSha256(body, secret, `v1=${sig}`)).toBe(true);
  });
  test('rejects a wrong signature / missing header', () => {
    expect(verifyHmacSha256(body, secret, 'deadbeef')).toBe(false);
    expect(verifyHmacSha256(body, secret, undefined)).toBe(false);
    expect(verifyHmacSha256(body + 'x', secret, sig)).toBe(false);
  });
});

describe('verifySvix (Daytona)', () => {
  const secretRaw = Buffer.from('daytona-test-key').toString('base64');
  const secret = `whsec_${secretRaw}`;
  const id = 'msg_1';
  const ts = '1700000000';
  const body = '{"event":"sandbox.state.updated","id":"sb2","newState":"stopped"}';
  const expected = createHmac('sha256', Buffer.from(secretRaw, 'base64'))
    .update(`${id}.${ts}.${body}`, 'utf8')
    .digest('base64');
  test('accepts a correct v1 signature', () => {
    expect(verifySvix(body, secret, { id, timestamp: ts, signature: `v1,${expected}` })).toBe(true);
  });
  test('rejects wrong / incomplete', () => {
    expect(verifySvix(body, secret, { id, timestamp: ts, signature: 'v1,nope' })).toBe(false);
    expect(verifySvix(body, secret, { id: undefined, timestamp: ts, signature: `v1,${expected}` })).toBe(false);
  });
});

function svixHeaders(secret: string, id: string, ts: string, body: string): (h: string) => string | undefined {
  const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
    .update(`${id}.${ts}.${body}`, 'utf8')
    .digest('base64');
  const map: Record<string, string> = {
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${sig}`,
  };
  return (h: string) => map[h.toLowerCase()];
}

describe('handleDaytonaWebhook', () => {
  const secret = `whsec_${Buffer.from('k').toString('base64')}`;
  test('503 when not configured', async () => {
    const r = await handleDaytonaWebhook('{}', () => undefined);
    expect(r.status).toBe(503);
  });
  test('401 on bad signature', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const r = await handleDaytonaWebhook('{"id":"sb"}', () => 'bad');
    expect(r.status).toBe(401);
  });
  test('closes billing on a stopped state', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state.updated', id: 'sbA', newState: 'stopped', updatedAt: 't1' });
    const r = await handleDaytonaWebhook(body, svixHeaders(secret, 'm1', '100', body));
    expect(r.status).toBe(200);
    expect(stoppedCalls).toEqual(['sbA']);
  });
  test('dedupes a repeated delivery', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state.updated', id: 'sbB', newState: 'stopped', updatedAt: 't1' });
    const hdr = svixHeaders(secret, 'm2', '100', body);
    await handleDaytonaWebhook(body, hdr);
    await handleDaytonaWebhook(body, hdr);
    expect(stoppedCalls).toEqual(['sbB']); // second is deduped
  });
});

describe('handlePlatinumWebhook', () => {
  const secret = 'whsec_plat';
  function hmacHeader(body: string): (h: string) => string | undefined {
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    return (h: string) => (h.toLowerCase() === 'x-platinum-signature' ? sig : undefined);
  }
  test('503 when not configured', async () => {
    const r = await handlePlatinumWebhook('{}', () => undefined);
    expect(r.status).toBe(503);
  });
  test('removes on a delete event', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.deleted', id: 'pX', state: 'deleted' });
    const r = await handlePlatinumWebhook(body, hmacHeader(body));
    expect(r.status).toBe(200);
    expect(removedCalls).toEqual(['pX']);
  });
  test('noop on started', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state_updated', id: 'pY', state: 'running' });
    const r = await handlePlatinumWebhook(body, hmacHeader(body));
    expect(r.status).toBe(200);
    expect(stoppedCalls).toEqual([]);
    expect(removedCalls).toEqual([]);
  });
});

describe('verifyE2B', () => {
  const secret = 'e2b-test-secret';
  const body = '{"event":"sandbox.lifecycle.killed","payload":{"sandbox_id":"sb_e2b"}}';
  // E2B's documented scheme (docs/sandbox/lifecycle-events-webhooks.md):
  //   base64( sha256( secret + rawBody ) ) with trailing '=' stripped.
  const e2bSignature = (payload: string) =>
    createHash('sha256').update(secret + payload, 'utf8').digest('base64').replace(/=+$/, '');
  test('accepts the documented sha256(secret+body) signature', () => {
    expect(verifyE2B(body, secret, e2bSignature(body))).toBe(true);
  });
  test('rejects an HMAC signature (the old buggy scheme)', () => {
    const hmacSig = createHmac('sha256', secret).update(body, 'utf8').digest('base64').replace(/=+$/, '');
    expect(verifyE2B(body, secret, hmacSig)).toBe(false);
  });
  test('rejects a wrong signature / missing header', () => {
    expect(verifyE2B(body, secret, e2bSignature(body) + 'x')).toBe(false);
    expect(verifyE2B(body, secret, undefined)).toBe(false);
  });
});

describe('handleE2BWebhook', () => {
  const secret = 'e2b-webhook-secret';
  function e2bHeader(body: string): (h: string) => string | undefined {
    const sig = createHash('sha256').update(secret + body, 'utf8').digest('base64').replace(/=+$/, '');
    return (h: string) => (h.toLowerCase() === 'x-e2b-signature' ? sig : undefined);
  }
  test('503 when not configured', async () => {
    const r = await handleE2BWebhook('{}', () => undefined);
    expect(r.status).toBe(503);
  });
  test('401 on bad signature', async () => {
    cfg.E2B_WEBHOOK_SECRET = secret;
    const r = await handleE2BWebhook('{"type":"x"}', () => 'bad');
    expect(r.status).toBe(401);
  });
  test('closes billing on a killed event', async () => {
    cfg.E2B_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ type: 'sandbox.lifecycle.killed', sandbox_id: 'e2bA', id: 'evt-1' });
    const r = await handleE2BWebhook(body, e2bHeader(body));
    expect(r.status).toBe(200);
    expect(removedCalls).toEqual(['e2bA']);
  });
  test('stops billing on a paused event', async () => {
    cfg.E2B_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ type: 'sandbox.lifecycle.paused', sandbox_id: 'e2bB', id: 'evt-2' });
    const r = await handleE2BWebhook(body, e2bHeader(body));
    expect(r.status).toBe(200);
    expect(stoppedCalls).toEqual(['e2bB']);
  });
  test('dedupes a repeated delivery', async () => {
    cfg.E2B_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ type: 'sandbox.lifecycle.killed', sandbox_id: 'e2bC', id: 'evt-3' });
    const hdr = e2bHeader(body);
    await handleE2BWebhook(body, hdr);
    await handleE2BWebhook(body, hdr);
    expect(removedCalls).toEqual(['e2bC']);
  });
});
