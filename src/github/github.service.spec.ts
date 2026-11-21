import { GitHubService, GitHubApiError } from './github.service';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
});

jest.spyOn(fs, 'readFileSync').mockReturnValue(privateKey as never);

describe('GitHubService', () => {
  let service: GitHubService;
  let fetchMock: jest.SpyInstance;

  const createResponse = (
    data: unknown,
    link: string | null = null,
    status = 200,
  ) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: jest.fn().mockResolvedValue(data),
      text: jest.fn().mockResolvedValue('GitHub API failure'),
      headers: {
        get: jest.fn().mockReturnValue(link),
      },
    }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();

    process.env.GITHUB_APP_ID = '123456';
    process.env.GITHUB_INSTALLATION_ID = '789012';
    process.env.GITHUB_PRIVATE_KEY_PATH = '/tmp/fake-private-key';

    fetchMock = jest.spyOn(global, 'fetch');

    service = new GitHubService();
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  function mockInstallationToken() {
    fetchMock.mockResolvedValueOnce(
      createResponse({
        token: 'test-installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
  }

  it('should collect alerts from multiple pages', async () => {
    mockInstallationToken();

    const firstPage = [{ number: 1 }, { number: 2 }];
    const secondPage = [{ number: 3 }];

    fetchMock
      .mockResolvedValueOnce(
        createResponse(
          firstPage,
          '<https://api.github.com/repos/test/repo/dependabot/alerts?page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(createResponse(secondPage));

    const alerts = await service.getAlerts('test', 'repo');

    expect(alerts).toEqual([...firstPage, ...secondPage]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should reject when a later page fails', async () => {
    mockInstallationToken();

    fetchMock
      .mockResolvedValueOnce(
        createResponse(
          [{ number: 1 }],
          '<https://api.github.com/repos/test/repo/dependabot/alerts?page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(
        createResponse('Internal Server Error', null, 500),
      );

    await expect(service.getAlerts('test', 'repo')).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });

  it('should reject an invalid alerts response', async () => {
    mockInstallationToken();

    fetchMock.mockResolvedValueOnce(createResponse({ invalid: true }));

    await expect(service.getAlerts('test', 'repo')).rejects.toThrow(
      'Invalid Dependabot alerts response for test/repo',
    );
  });

  it('should reject an external pagination URL', async () => {
    mockInstallationToken();

    fetchMock.mockResolvedValueOnce(
      createResponse(
        [{ number: 1 }],
        '<https://malicious.example.com/page/2>; rel="next"',
      ),
    );

    await expect(service.getAlerts('test', 'repo')).rejects.toThrow(
      'Invalid GitHub pagination URL',
    );
  });

  it('should reuse the installation token between requests', async () => {
    mockInstallationToken();

    fetchMock
      .mockResolvedValueOnce(createResponse([{ number: 1 }]))
      .mockResolvedValueOnce(createResponse([{ number: 2 }]));

    await service.getAlerts('test', 'repo');
    await service.getAlerts('test', 'repo');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should detect pagination loops', async () => {
    mockInstallationToken();

    const repeatedUrl =
      '<https://api.github.com/repos/test/repo/dependabot/alerts?page=2>; rel="next"';

    fetchMock
      .mockResolvedValueOnce(createResponse([{ number: 1 }], repeatedUrl))
      .mockResolvedValueOnce(createResponse([{ number: 2 }], repeatedUrl));

    await expect(service.getAlerts('test', 'repo')).rejects.toThrow(
      'GitHub pagination loop detected for test/repo',
    );

    // Token + first page + second page.
    // No third request should occur.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  describe('getDefaultBranchCommitSha', () => {
    it('should return the SHA of the default branch commit', async () => {
      mockInstallationToken();

      fetchMock
        .mockResolvedValueOnce(
          createResponse({
            default_branch: 'main',
          }),
        )
        .mockResolvedValueOnce(
          createResponse({
            sha: 'a'.repeat(40),
          }),
        );

      const sha = await service.getDefaultBranchCommitSha('test', 'repo');

      expect(sha).toBe('a'.repeat(40));
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const repositoryRequest = fetchMock.mock.calls[1];
      const commitRequest = fetchMock.mock.calls[2];

      expect(repositoryRequest[0]).toContain('/repos/test/repo');
      expect(commitRequest[0]).toContain('/commits/main');
    });

    it('should reject an invalid default branch response', async () => {
      mockInstallationToken();
      fetchMock.mockResolvedValueOnce(createResponse({ default_branch: '' }));

      await expect(
        service.getDefaultBranchCommitSha('test', 'repo'),
      ).rejects.toThrow('Invalid GitHub default branch response');
    });

    it('should reject an invalid commit SHA', async () => {
      mockInstallationToken();

      fetchMock
        .mockResolvedValueOnce(createResponse({ default_branch: 'main' }))
        .mockResolvedValueOnce(createResponse({ sha: 'invalid-sha' }));

      await expect(
        service.getDefaultBranchCommitSha('test', 'repo'),
      ).rejects.toThrow('Invalid GitHub commit SHA');
    });
  });

  describe('getRepositories', () => {
    it('should collect repositories from multiple pages', async () => {
      mockInstallationToken();

      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        name: `repo-${index + 1}`,
      }));

      const secondPage = [
        { id: 101, name: 'repo-101' },
        { id: 102, name: 'repo-102' },
      ];

      fetchMock
        .mockResolvedValueOnce(createResponse({ repositories: firstPage }))
        .mockResolvedValueOnce(createResponse({ repositories: secondPage }));

      const repositories = await service.getRepositories();

      expect(repositories).toHaveLength(102);
      expect(repositories[0].name).toBe('repo-1');
      expect(repositories[101].name).toBe('repo-102');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should reject an invalid repositories response', async () => {
      mockInstallationToken();

      fetchMock.mockResolvedValueOnce(createResponse({ invalid: true }));

      await expect(service.getRepositories()).rejects.toThrow(
        'Invalid GitHub repositories response',
      );
    });

    it('should reject when a later repositories page fails', async () => {
      mockInstallationToken();

      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        name: `repo-${index + 1}`,
      }));

      fetchMock
        .mockResolvedValueOnce(createResponse({ repositories: firstPage }))
        .mockResolvedValueOnce(
          createResponse('Internal Server Error', null, 500),
        );

      await expect(service.getRepositories()).rejects.toBeInstanceOf(
        GitHubApiError,
      );
    });
  });

  describe('downloadRepositoryArchive', () => {
    const commitSha = 'a'.repeat(40);
    const archiveUrl = 'https://codeload.github.com/test/repo/tar.gz/main';

    function mockArchiveRedirect(location: string, status = 302) {
      return {
        status,
        ok: false,
        headers: {
          get: jest.fn().mockReturnValue(location),
        },
      } as unknown as Response;
    }

    it('should download an archive from the validated codeload host', async () => {
      mockInstallationToken();

      fetchMock
        .mockResolvedValueOnce(mockArchiveRedirect(archiveUrl))
        .mockResolvedValueOnce(new Response('archive-content'));

      const result = await service.downloadRepositoryArchive(
        'test',
        'repo',
        commitSha,
      );

      expect(result).toEqual(Buffer.from('archive-content'));
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const apiRequest = fetchMock.mock.calls[1];
      const downloadRequest = fetchMock.mock.calls[2];

      expect(apiRequest[0]).toContain('/tarball/');
      expect(apiRequest[1].headers.Authorization).toBe(
        'Bearer test-installation-token',
      );

      expect(String(downloadRequest[0])).toBe(archiveUrl);
      expect(downloadRequest[1].headers).toBeUndefined();
    });

    it('should reject an archive redirect to an external host', async () => {
      mockInstallationToken();

      fetchMock.mockResolvedValueOnce(
        mockArchiveRedirect('https://malicious.example.com/archive'),
      );

      await expect(
        service.downloadRepositoryArchive('test', 'repo', commitSha),
      ).rejects.toThrow('Invalid GitHub archive download URL');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should reject an archive redirect containing credentials', async () => {
      mockInstallationToken();

      fetchMock.mockResolvedValueOnce(
        mockArchiveRedirect(
          'https://attacker@codeload.github.com/test/repo/archive',
        ),
      );

      await expect(
        service.downloadRepositoryArchive('test', 'repo', commitSha),
      ).rejects.toThrow('Invalid GitHub archive download URL');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should reject an invalid commit SHA without making requests', async () => {
      await expect(
        service.downloadRepositoryArchive('test', 'repo', 'invalid-sha'),
      ).rejects.toThrow('Invalid GitHub commit SHA');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject an unexpected GitHub archive response status', async () => {
      mockInstallationToken();

      fetchMock.mockResolvedValueOnce(createResponse(null, null, 404));

      await expect(
        service.downloadRepositoryArchive('test', 'repo', commitSha),
      ).rejects.toBeInstanceOf(GitHubApiError);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should reject an archive exceeding the declared content length', async () => {
      mockInstallationToken();

      fetchMock
        .mockResolvedValueOnce(mockArchiveRedirect(archiveUrl))
        .mockResolvedValueOnce(
          new Response('archive-content', {
            headers: {
              'content-length': String(101 * 1024 * 1024),
            },
          }),
        );

      await expect(
        service.downloadRepositoryArchive('test', 'repo', commitSha),
      ).rejects.toThrow('GitHub archive exceeds the maximum allowed size');
    });

    it('should stop streaming when the archive exceeds the size limit', async () => {
      mockInstallationToken();

      const cancel = jest.fn().mockResolvedValue(undefined);
      const releaseLock = jest.fn();

      const oversizedReader = {
        read: jest.fn().mockResolvedValue({
          done: false,
          value: {
            byteLength: 101 * 1024 * 1024,
          },
        }),
        cancel,
        releaseLock,
      };

      const oversizedBody = {
        getReader: jest.fn().mockReturnValue(oversizedReader),
      };

      fetchMock
        .mockResolvedValueOnce(mockArchiveRedirect(archiveUrl))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn().mockReturnValue(null),
          },
          body: oversizedBody,
        } as unknown as Response);

      await expect(
        service.downloadRepositoryArchive('test', 'repo', commitSha),
      ).rejects.toThrow('GitHub archive exceeds the maximum allowed size');

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    });
  });
});
