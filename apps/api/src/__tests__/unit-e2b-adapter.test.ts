import { describe, expect, mock, test } from 'bun:test';

// From __tests__/:
//   ../config              = src/config
//   ../shared/e2b          = src/shared/e2b
//   ../shared/with-timeout = src/shared/with-timeout
//   ../snapshots/xxx       = src/snapshots/xxx

mock.module('../config', () => ({
  config: { E2B_API_KEY: 'e2b-key-1' },
}));

const mockStageBuildContext = mock(() => Promise.resolve({ contextDir: '/tmp/ctx', dockerfileName: 'Dockerfile.kortix', composedPath: '/tmp/ctx/Dockerfile.kortix' }));
const mockDeleteE2BTemplate = mock(() => Promise.resolve());

mock.module('../shared/e2b', () => ({
  isE2BConfigured: () => true,
  deleteE2BTemplate: mockDeleteE2BTemplate,
}));

mock.module('../shared/with-timeout', () => ({
  withTimeout: async <T>(p: Promise<T>) => p,
}));

mock.module('../snapshots/build-context', () => ({
  stageBuildContext: mockStageBuildContext,
  DEFAULT_CPU: 2,
  DEFAULT_MEMORY_GB: 4,
  KORTIX_ENTRYPOINT: 'bash /opt/kortix/agent.sh',
}));

const mockBuild = mock(() => Promise.resolve({ templateId: 'tmpl-id-1', buildId: 'build-1' }));
const mockGetBuildStatus = mock(() => Promise.resolve({ status: 'ready' }));

let templateExists = true;
function MockTemplate() {
  return {
    fromDockerfile: () => ({
      setEnvs: () => ({
        copy: () => ({}),
      }),
    }),
  };
}
MockTemplate.build = mockBuild;
MockTemplate.exists = mock(() => Promise.resolve(templateExists));
MockTemplate.getBuildStatus = mockGetBuildStatus;

mock.module('e2b', () => ({ Template: MockTemplate, Sandbox: {} }));

const { e2bProvider } = await import('../snapshots/providers/e2b');

describe('E2BAdapter', () => {
  test('id is e2b', () => {
    expect(e2bProvider.id).toBe('e2b');
  });

  test('isConfigured returns true', () => {
    expect(e2bProvider.isConfigured()).toBe(true);
  });

  test('buildSnapshot throws without image or dockerfile', async () => {
    await expect(
      e2bProvider.buildSnapshot({ snapshotName: 's', slug: 's', spec: {} } as any),
    ).rejects.toThrow('neither image nor userDockerfile');
  });

  test('buildSnapshot builds from dockerfile and waits for ready', async () => {
    await e2bProvider.buildSnapshot({
      snapshotName: 'tmpl-test',
      slug: 'test',
      userDockerfile: 'FROM node:20\nRUN echo hi',
      spec: { cpu: 2, memoryGb: 4 },
    });
    expect(mockBuild).toHaveBeenCalled();
    expect(mockGetBuildStatus).toHaveBeenCalled();
  });

  test('getSnapshotState returns active when template exists', async () => {
    templateExists = true;
    const state = await e2bProvider.getSnapshotState('tmpl-active');
    expect(state).toBe('active');
  });

  test('getSnapshotState returns missing when template does not exist', async () => {
    templateExists = false;
    const state = await e2bProvider.getSnapshotState('tmpl-missing');
    expect(state).toBe('missing');
  });

  test('deleteSnapshot calls deleteE2BTemplate', async () => {
    await e2bProvider.deleteSnapshot('tmpl-to-delete');
    expect(mockDeleteE2BTemplate).toHaveBeenCalledWith('tmpl-to-delete');
  });
});
