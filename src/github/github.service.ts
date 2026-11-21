import { Injectable, InternalServerErrorException } from '@nestjs/common';

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface InstallationToken {
  token: string;
  expires_at: string;
}

interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
}

interface GitHubCommit {
  sha: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

@Injectable()
export class GitHubService {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKey: string;

  private installationToken?: string;
  private tokenExpiresAt?: number;

  private readonly baseUrl = 'https://api.github.com';

  constructor() {
    const appId = process.env.GITHUB_APP_ID;
    const installationId = process.env.GITHUB_INSTALLATION_ID;
    const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

    if (!appId || !installationId || !privateKeyPath) {
      throw new InternalServerErrorException(
        'GitHub App configuration is missing',
      );
    }

    this.appId = appId;
    this.installationId = installationId;
    this.privateKey = readFileSync(privateKeyPath, 'utf8');
  }

  private createJwt(): string {
    const now = Math.floor(Date.now() / 1000);

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const payload = {
      iat: now - 60,
      exp: now + 540,
      iss: this.appId,
    };

    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    const unsignedToken = `${encode(header)}.${encode(payload)}`;

    const signer = createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();

    const signature = signer.sign(this.privateKey).toString('base64url');

    return `${unsignedToken}.${signature}`;
  }

  private async getInstallationToken(): Promise<string> {
    if (
      this.installationToken &&
      this.tokenExpiresAt &&
      Date.now() < this.tokenExpiresAt - 60_000
    ) {
      return this.installationToken;
    }

    const jwt = this.createJwt();

    const response = await fetch(
      `${this.baseUrl}/app/installations/${this.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      throw new GitHubApiError(
        `Failed to create installation token: ${await response.text()}`,
        response.status,
      );
    }

    const data = (await response.json()) as InstallationToken;

    this.installationToken = data.token;
    this.tokenExpiresAt = new Date(data.expires_at).getTime();

    return data.token;
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.getInstallationToken();

    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub API error: ${await response.text()}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  async getRepositories(): Promise<GitHubRepository[]> {
    const repositories: GitHubRepository[] = [];

    let page = 1;

    while (true) {
      const result = await this.request<{
        repositories: GitHubRepository[];
      }>(`/installation/repositories?per_page=100&page=${page}`);

      if (!result || !Array.isArray(result.repositories)) {
        throw new Error('Invalid GitHub repositories response');
      }

      repositories.push(...result.repositories);

      if (result.repositories.length < 100) {
        break;
      }

      page++;
    }

    return repositories;
  }

  async getAlerts(owner: string, repo: string) {
    const params = new URLSearchParams({
      state: 'open,dismissed,fixed,auto_dismissed',
      per_page: '100',
    });

    let url =
      `${this.baseUrl}/repos/${encodeURIComponent(owner)}` +
      `/${encodeURIComponent(repo)}/dependabot/alerts?${params}`;

    const alerts: any[] = [];
    const visitedUrls = new Set<string>();

    while (url) {
      if (visitedUrls.has(url)) {
        throw new Error(`GitHub pagination loop detected for ${owner}/${repo}`);
      }

      visitedUrls.add(url);

      const { data, nextUrl } = await this.requestPage<any[]>(url);

      if (!Array.isArray(data)) {
        throw new Error(
          `Invalid Dependabot alerts response for ${owner}/${repo}`,
        );
      }

      alerts.push(...data);
      url = nextUrl ?? '';
    }

    return alerts;
  }

  private async requestPage<T>(
    url: string,
  ): Promise<{ data: T; nextUrl: string | null }> {
    const token = await this.getInstallationToken();

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub API error: ${await response.text()}`,
        response.status,
      );
    }

    const linkHeader = response.headers.get('link');

    const nextLink = linkHeader
      ?.split(',')
      .map((link) => link.trim())
      .find((link) => /rel="next"/.test(link));

    const nextUrl = nextLink?.match(/<([^>]+)>/)?.[1] ?? null;

    if (nextUrl) {
      const parsedUrl = new URL(nextUrl);

      if (
        parsedUrl.protocol !== 'https:' ||
        parsedUrl.hostname !== 'api.github.com'
      ) {
        throw new Error('Invalid GitHub pagination URL');
      }
    }

    return {
      data: (await response.json()) as T,
      nextUrl,
    };
  }

  async getDefaultBranchCommitSha(
    owner: string,
    repo: string,
  ): Promise<string> {
    const repository = await this.request<{
      default_branch: string;
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);

    if (
      typeof repository.default_branch !== 'string' ||
      repository.default_branch.length === 0
    ) {
      throw new Error('Invalid GitHub default branch response');
    }

    const commit = await this.request<GitHubCommit>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(repository.default_branch)}`,
    );

    if (!/^[0-9a-f]{40}$/i.test(commit.sha)) {
      throw new Error('Invalid GitHub commit SHA');
    }

    return commit.sha;
  }

  async downloadRepositoryArchive(
    owner: string,
    repo: string,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
      throw new Error('Invalid GitHub commit SHA');
    }

    const maxArchiveSize = 100 * 1024 * 1024;
    const token = await this.getInstallationToken();

    const archiveUrl =
      `${this.baseUrl}/repos/` +
      `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `/tarball/${commitSha}`;

    const response = await fetch(archiveUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (response.status !== 302 && response.status !== 301) {
      throw new GitHubApiError(
        `GitHub archive download failed: ${response.status}`,
        response.status,
      );
    }

    const location = response.headers.get('location');

    if (!location) {
      throw new Error('GitHub archive redirect is missing location');
    }

    const downloadUrl = new URL(location);

    if (
      downloadUrl.protocol !== 'https:' ||
      downloadUrl.hostname !== 'codeload.github.com' ||
      downloadUrl.port !== '' ||
      downloadUrl.username !== '' ||
      downloadUrl.password !== ''
    ) {
      throw new Error('Invalid GitHub archive download URL');
    }

    const downloadResponse = await fetch(downloadUrl, {
      method: 'GET',
      redirect: 'error',
      signal,
    });

    if (!downloadResponse.ok) {
      throw new GitHubApiError(
        `GitHub archive download failed: ${downloadResponse.status}`,
        downloadResponse.status,
      );
    }

    const contentLength = downloadResponse.headers.get('content-length');

    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength)) {
        throw new Error('Invalid GitHub archive content length');
      }

      const declaredSize = Number(contentLength);

      if (
        !Number.isSafeInteger(declaredSize) ||
        declaredSize > maxArchiveSize
      ) {
        throw new Error('GitHub archive exceeds the maximum allowed size');
      }
    }

    if (!downloadResponse.body) {
      throw new Error('GitHub archive response has no body');
    }

    const reader = downloadResponse.body.getReader();
    const chunks: Buffer[] = [];
    let totalSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        totalSize += value.byteLength;

        if (totalSize > maxArchiveSize) {
          await reader.cancel();
          throw new Error('GitHub archive exceeds the maximum allowed size');
        }

        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    if (totalSize === 0) {
      throw new Error('GitHub archive is empty');
    }

    return Buffer.concat(chunks, totalSize);
  }
}
