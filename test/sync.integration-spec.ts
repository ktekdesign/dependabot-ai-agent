import { randomUUID } from 'node:crypto';

import { AlertState } from '@prisma/client';

import { PrismaService } from '../src/database/prisma.service';
import { GitHubService } from '../src/github/github.service';
import { RepositoriesService } from '../src/repositories/repositories.service';
import { AlertsService } from '../src/alerts/alerts.service';
import { SyncService } from '../src/sync/sync.service';
import { SyncLockService } from '../src/sync/sync-lock.service';

describe('SyncService (integration)', () => {
  let prisma: PrismaService;
  let syncService: SyncService;
  let syncLock: SyncLockService;

  const githubMock = {
    getRepositories: jest.fn(),
    getAlerts: jest.fn(),
  };

  const repositoryPrefix = 'integration-sync';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';

    prisma = new PrismaService();
    await prisma.$connect();

    syncLock = new SyncLockService();

    const github = githubMock as unknown as GitHubService;
    const repositories = new RepositoriesService(prisma);
    const alerts = new AlertsService(prisma);

    syncService = new SyncService(github, repositories, alerts, syncLock);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await prisma.repository.deleteMany({
      where: {
        fullName: {
          startsWith: `${repositoryPrefix}/`,
        },
      },
    });
  });

  afterAll(async () => {
    await syncLock.onModuleDestroy();
    await prisma.$disconnect();
  });

  it('should synchronize repositories and persist their alerts', async () => {
    const suffix = randomUUID();

    const repository = {
      id: Date.now() + Math.floor(Math.random() * 100000),
      name: suffix,
      full_name: `${repositoryPrefix}/${suffix}`,
      owner: {
        login: repositoryPrefix,
      },
    };

    githubMock.getRepositories.mockResolvedValue([repository]);

    githubMock.getAlerts.mockResolvedValue([
      {
        number: 101,
        state: 'open',
        dependency: {
          package: {
            name: 'lodash',
            ecosystem: 'npm',
          },
          manifest_path: 'package-lock.json',
        },
        security_vulnerability: {
          severity: 'high',
          vulnerable_version_range: '< 4.17.21',
          first_patched_version: {
            identifier: '4.17.21',
          },
        },
        security_advisory: {
          cve_id: 'CVE-TEST-101',
        },
        created_at: '2026-11-18T10:00:00Z',
        updated_at: '2026-11-18T12:00:00Z',
      },
    ]);

    const summary = await syncService.sync();

    const storedRepository = await prisma.repository.findUnique({
      where: {
        fullName: repository.full_name,
      },
      include: {
        alerts: true,
      },
    });

    expect(summary).toEqual({
      discovered: 1,
      enabled: 1,
      disabled: 0,
      failed: 0,
      alertsSynced: 1,
    });

    expect(storedRepository).not.toBeNull();
    expect(storedRepository?.monitoringStatus).toBe('ENABLED');
    expect(storedRepository?.alerts).toHaveLength(1);

    expect(storedRepository?.alerts[0]).toMatchObject({
      alertNumber: 101,
      packageName: 'lodash',
      ecosystem: 'npm',
      severity: 'high',
      cveId: 'CVE-TEST-101',
      patchedVersion: '4.17.21',
      state: AlertState.OPEN,
      isPresent: true,
    });

    expect(githubMock.getRepositories).toHaveBeenCalledTimes(1);
    expect(githubMock.getAlerts).toHaveBeenCalledWith(repositoryPrefix, suffix);
  });

  it('should mark repository as NOT_ENABLED when Dependabot is disabled', async () => {
    const suffix = randomUUID();

    const repository = {
      id: Date.now() + Math.floor(Math.random() * 100000),
      name: suffix,
      full_name: `${repositoryPrefix}/${suffix}`,
      owner: {
        login: repositoryPrefix,
      },
    };

    githubMock.getRepositories.mockResolvedValue([repository]);

    githubMock.getAlerts.mockRejectedValue(
      Object.assign(
        new Error('Dependabot alerts are disabled for this repository'),
        { status: 403 },
      ),
    );

    const summary = await syncService.sync();

    const storedRepository = await prisma.repository.findUnique({
      where: {
        fullName: repository.full_name,
      },
    });

    expect(summary).toEqual({
      discovered: 1,
      enabled: 0,
      disabled: 1,
      failed: 0,
      alertsSynced: 0,
    });

    expect(storedRepository?.monitoringStatus).toBe('NOT_ENABLED');
  });

  it('should mark repository as ERROR when GitHub API fails unexpectedly', async () => {
    const suffix = randomUUID();

    const repository = {
      id: Date.now() + Math.floor(Math.random() * 100000),
      name: suffix,
      full_name: `${repositoryPrefix}/${suffix}`,
      owner: {
        login: repositoryPrefix,
      },
    };

    githubMock.getRepositories.mockResolvedValue([repository]);

    githubMock.getAlerts.mockRejectedValue(
      Object.assign(new Error('GitHub API unavailable'), {
        status: 500,
      }),
    );

    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      const summary = await syncService.sync();

      const storedRepository = await prisma.repository.findUnique({
        where: {
          fullName: repository.full_name,
        },
      });

      expect(summary).toEqual({
        discovered: 1,
        enabled: 0,
        disabled: 0,
        failed: 1,
        alertsSynced: 0,
      });

      expect(storedRepository?.monitoringStatus).toBe('ERROR');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('should skip a concurrent synchronization while another is running', async () => {
    const suffix = randomUUID();

    const repository = {
      id: Date.now() + Math.floor(Math.random() * 100000),
      name: suffix,
      full_name: `${repositoryPrefix}/${suffix}`,
      owner: {
        login: repositoryPrefix,
      },
    };

    let signalStarted!: () => void;
    let continueSync!: () => void;

    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const gate = new Promise<void>((resolve) => {
      continueSync = resolve;
    });

    githubMock.getRepositories.mockImplementation(async () => {
      signalStarted();
      await gate;
      return [repository];
    });

    githubMock.getAlerts.mockResolvedValue([]);

    // First synchronization acquires the PostgreSQL lock.
    const firstSync = syncService.sync();

    // Wait until the first synchronization reaches GitHub.
    await started;

    // Second synchronization must be rejected by the lock.
    const secondSummary = await syncService.sync();

    expect(secondSummary).toEqual({
      discovered: 0,
      enabled: 0,
      disabled: 0,
      failed: 0,
      alertsSynced: 0,
      skipped: true,
    });

    expect(githubMock.getRepositories).toHaveBeenCalledTimes(1);

    // Allow the first synchronization to finish.
    continueSync();

    const firstSummary = await firstSync;

    expect(firstSummary).toEqual({
      discovered: 1,
      enabled: 1,
      disabled: 0,
      failed: 0,
      alertsSynced: 0,
    });

    expect(githubMock.getRepositories).toHaveBeenCalledTimes(1);
  });

  it('should preserve existing alerts when GitHub pagination fails', async () => {
    const suffix = randomUUID();
    const fullName = `${repositoryPrefix}/${suffix}`;
    const alertNumber = 9001;

    // Arrange: persist a repository and an existing alert.
    const repository = await prisma.repository.create({
      data: {
        githubId: BigInt(Date.now() + Math.floor(Math.random() * 100000)),
        owner: repositoryPrefix,
        name: suffix,
        fullName,
        monitoringStatus: 'ENABLED',
      },
    });

    await prisma.securityAlert.create({
      data: {
        repositoryId: repository.id,
        alertNumber,
        packageName: 'lodash',
        ecosystem: 'npm',
        severity: 'high',
        cveId: 'CVE-TEST-9001',
        state: AlertState.OPEN,
        isPresent: true,
        lastSeenAt: new Date(),
      },
    });

    githubMock.getRepositories.mockResolvedValue([
      {
        id: Number(repository.githubId),
        name: suffix,
        full_name: fullName,
        owner: {
          login: repositoryPrefix,
        },
      },
    ]);

    // Simulate page 1 succeeding and page 2 failing.
    // getAlerts rejects without returning an incomplete snapshot.
    githubMock.getAlerts.mockRejectedValue(
      new Error('GitHub pagination failed on page 2'),
    );

    // Act: execute synchronization.
    const summary = await syncService.sync();

    // Assert: synchronization reports the failure.
    expect(summary).toEqual({
      discovered: 1,
      enabled: 0,
      disabled: 0,
      failed: 1,
      alertsSynced: 0,
    });

    // Assert: the existing alert was not marked as absent.
    const storedAlert = await prisma.securityAlert.findUnique({
      where: {
        repositoryId_alertNumber: {
          repositoryId: repository.id,
          alertNumber,
        },
      },
    });

    expect(storedAlert).not.toBeNull();
    expect(storedAlert?.isPresent).toBe(true);
    expect(storedAlert?.state).toBe(AlertState.OPEN);

    // The repository should reflect the failed synchronization.
    const storedRepository = await prisma.repository.findUnique({
      where: {
        fullName,
      },
    });

    expect(storedRepository?.monitoringStatus).toBe('ERROR');
  });
});
