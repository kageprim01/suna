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

class SandboxNotFoundErrorMock extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxNotFoundError';
  }
}

mock.module('e2b', () => ({ Sandbox: MockSandbox, Template: {}, SandboxNotFoundError: SandboxNotFoundErrorMock }));

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
      timeoutMs: 30 * 60 * 1000,
      envs: expect.objectContaining({ KORTIX_TOKEN: 'tok-1' }),
    }));
  });

  test('create defaults to 1h TTL (E2B Hobby max) when autoStopInterval is unset', async () => {
    await provider.create({
      accountId: 'acct-1',
      userId: 'user-1',
      name: 'test-sb',
      snapshot: 'tmpl-project-1',
      envVars: { KORTIX_TOKEN: 'tok-1' },
    });
    expect(mockCreate).toHaveBeenCalledWith('tmpl-project-1', expect.objectContaining({
      timeoutMs: 60 * 60 * 1000,
    }));
  });

  test('create caps warm-pool (autoStopInterval 0) at 1h TTL', async () => {
    await provider.create({
      accountId: 'acct-1',
      userId: 'user-1',
      name: 'test-sb',
      snapshot: 'tmpl-project-1',
      envVars: { KORTIX_TOKEN: 'tok-1' },
      autoStopInterval: 0,
    });
    expect(mockCreate).toHaveBeenCalledWith('tmpl-project-1', expect.objectContaining({
      timeoutMs: 60 * 60 * 1000,
    }));
  });

  test('create clamps an over-long autoStopInterval to the 1h Hobby max', async () => {
    await provider.create({
      accountId: 'acct-1',
      userId: 'user-1',
      name: 'test-sb',
      snapshot: 'tmpl-project-1',
      envVars: { KORTIX_TOKEN: 'tok-1' },
      autoStopInterval: 120,
    });
    expect(mockCreate).toHaveBeenCalledWith('tmpl-project-1', expect.objectContaining({
      timeoutMs: 60 * 60 * 1000,
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

  test('resolvePreviewLink normalizes scheme-less getHost() to https', async () => {
    const link = await provider.resolvePreviewLink('e2b-sbx-1', 8000);
    expect(link.url).toBe('https://8000-e2b-sbx-1.e2b.app');
    expect(link.token).toBe('tok_abc');
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

  test('getStatus returns not_found on SandboxNotFoundError', async () => {
    MockSandbox.getInfo = mock(() => Promise.reject(new SandboxNotFoundErrorMock('Sandbox e2b-sbx-gone not found')));
    const status = await provider.getStatus('e2b-sbx-gone');
    expect(status).toBe('not_found');
    MockSandbox.getInfo = mock(() => Promise.resolve({ state: mockGetInfoValue }));
  });

  test('ensureRunning throws SandboxNotFoundError when the box is gone', async () => {
    MockSandbox.getInfo = mock(() => Promise.reject(new SandboxNotFoundErrorMock('Paused sandbox e2b-sbx-gone not found')));
    await expect(provider.ensureRunning('e2b-sbx-gone')).rejects.toThrow('reprovision');
    MockSandbox.getInfo = mock(() => Promise.resolve({ state: mockGetInfoValue }));
  });
});
