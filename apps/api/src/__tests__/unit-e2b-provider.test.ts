import { describe, expect, mock, test } from 'bun:test';

// Mock config module — specifier '.../config' resolves from __tests__/ to src/config
mock.module('../config', () => ({
  config: {
    KORTIX_URL: 'http://localhost:8008',
    INTERNAL_AGENTICA_ENV: 'test',
    E2B_API_KEY: 'e2b-key-1',
  },
  SANDBOX_VERSION: '1.0',
}));

mock.module('../../shared/e2b', () => ({
  getE2BApiKey: () => 'e2b-key-1',
  isE2BConfigured: () => true,
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => null,
}));

mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'http://localhost:3000',
}));

const mockCreate = mock(() => Promise.resolve({ sandboxId: 'e2b-sbx-1' }));
const mockConnect = mock(() => Promise.resolve({ getHost: () => 'https://8000-e2b-sbx-1.e2b.app', trafficAccessToken: 'tok_abc' }));
const mockPause = mock(() => Promise.resolve());
const mockKill = mock(() => Promise.resolve());
let mockGetInfoValue = 'running';
const mockListPaginator = { hasNext: false, nextItems: mock(() => Promise.resolve([])) };

class MockSandbox {
  static create = mockCreate;
  static connect = mockConnect;
  static pause = mockPause;
  static kill = mockKill;
  static getInfo = mock(() => Promise.resolve({ state: mockGetInfoValue }));
  static list = mock(() => mockListPaginator);
}

mock.module('e2b', () => ({ Sandbox: MockSandbox, Template: {} }));

const { E2BProvider } = await import('../platform/providers/e2b');

describe('E2BProvider', () => {
  const provider = new E2BProvider();

  test('name is e2b', () => {
    expect(provider.name).toBe('e2b');
  });

  test('provisioning is non-async', () => {
    expect(provider.provisioning.async).toBe(false);
    expect(provider.provisioning.stages).toHaveLength(1);
  });

  test('getProvisioningStatus returns null', async () => {
    expect(await provider.getProvisioningStatus()).toBeNull();
  });

  test('create throws without KORTIX_TOKEN', async () => {
    await expect(
      provider.create({ accountId: 'a', userId: 'u', name: 's' }),
    ).rejects.toThrow('KORTIX_TOKEN');
  });

  test('create throws without snapshot', async () => {
    await expect(
      provider.create({ accountId: 'a', userId: 'u', name: 's', envVars: { KORTIX_TOKEN: 'tok' } }),
    ).rejects.toThrow('snapshot');
  });

  test('create provisions sandbox and returns result', async () => {
    const result = await provider.create({
      accountId: 'acct-1',
      userId: 'user-1',
      name: 'test-sb',
      snapshot: 'tmpl-project-1',
      envVars: { KORTIX_TOKEN: 'tok-1' },
      autoStopInterval: 30,
    });
    expect(result.externalId).toBe('e2b-sbx-1');
    expect(result.metadata.template).toBe('tmpl-project-1');
    expect(mockCreate).toHaveBeenCalledWith('tmpl-project-1', expect.objectContaining({
      timeout: 1800,
      envVars: expect.objectContaining({ KORTIX_TOKEN: 'tok-1' }),
    }));
  });

  test('start calls Sandbox.connect', async () => {
    await provider.start('e2b-sbx-1');
    expect(mockConnect).toHaveBeenCalledWith('e2b-sbx-1');
  });

  test('stop calls Sandbox.pause', async () => {
    await provider.stop('e2b-sbx-1');
    expect(mockPause).toHaveBeenCalledWith('e2b-sbx-1');
  });

  test('remove calls Sandbox.kill', async () => {
    await provider.remove('e2b-sbx-1');
    expect(mockKill).toHaveBeenCalledWith('e2b-sbx-1');
  });

  test('getStatus returns running for running state', async () => {
    mockGetInfoValue = 'running';
    const status = await provider.getStatus('e2b-sbx-1');
    expect(status).toBe('running');
  });

  test('getStatus returns stopped for paused state', async () => {
    mockGetInfoValue = 'paused';
    const status = await provider.getStatus('e2b-sbx-paused');
    expect(status).toBe('stopped');
  });

  test('getStatus returns unknown on error', async () => {
    MockSandbox.getInfo = mock(() => Promise.reject(new Error('not found')));
    const status = await provider.getStatus('e2b-sbx-missing');
    expect(status).toBe('unknown');
    MockSandbox.getInfo = mock(() => Promise.resolve({ state: mockGetInfoValue }));
  });
});
