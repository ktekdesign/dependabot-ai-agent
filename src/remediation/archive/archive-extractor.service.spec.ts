import { ArchiveExtractorService } from './archive-extractor.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { loadRemediationConfig } from '../config/remediation.config';

import { create } from 'tar';

import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

describe('ArchiveExtractorService', () => {
  let root: string;
  let workspaceRoot: string;
  let fixtureRoot: string;
  let workspaceService: WorkspaceService;
  let service: ArchiveExtractorService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archive-extractor-test-'));
    workspaceRoot = join(root, 'workspaces');
    fixtureRoot = join(root, 'fixtures');

    await mkdir(fixtureRoot);

    workspaceService = new WorkspaceService(
      loadRemediationConfig({
        REMEDIATION_WORKSPACE_ROOT: workspaceRoot,
      }),
    );

    service = new ArchiveExtractorService(workspaceService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  interface RawTarEntry {
    path: string;
    content?: string;
    type?: string;
  }

  function createPaxRecord(key: string, value: string): string {
    const payload = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(payload) + 1;

    while (true) {
      const record = `${length}${payload}`;
      const actualLength = Buffer.byteLength(record);

      if (actualLength === length) {
        return record;
      }

      length = actualLength;
    }
  }

  function createRawTar(entries: RawTarEntry[]): Buffer {
    const blocks: Buffer[] = [];

    for (const entry of entries) {
      const content = Buffer.from(entry.content ?? '');
      const header = Buffer.alloc(512);

      header.write(entry.path, 0, 100, 'utf8');
      header.write('0000644\0', 100, 8, 'ascii');
      header.write('0000000\0', 108, 8, 'ascii');
      header.write('0000000\0', 116, 8, 'ascii');

      const size = entry.type === '5' ? 0 : content.length;
      header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      header.write('00000000000\0', 136, 12, 'ascii');

      header.fill(0x20, 148, 156);
      header.write(entry.type ?? '0', 156, 1, 'ascii');
      header.write('ustar\0', 257, 6, 'ascii');
      header.write('00', 263, 2, 'ascii');

      const checksum = header.reduce((sum, byte) => sum + byte, 0);

      header.write(
        checksum.toString(8).padStart(6, '0') + '\0 ',
        148,
        8,
        'ascii',
      );

      blocks.push(header);

      if (content.length > 0) {
        blocks.push(content);

        const remainder = content.length % 512;
        if (remainder !== 0) {
          blocks.push(Buffer.alloc(512 - remainder));
        }
      }
    }

    blocks.push(Buffer.alloc(1024));

    return gzipSync(Buffer.concat(blocks));
  }

  async function createArchive(): Promise<Buffer> {
    const archive = create(
      {
        cwd: fixtureRoot,
        gzip: true,
        portable: true,
      },
      ['repository'],
    );

    const chunks: Buffer[] = [];

    for await (const chunk of archive) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  async function createWorkspace() {
    return workspaceService.createWorkspace(randomUUID());
  }

  it('extracts a valid repository archive', async () => {
    const repositoryRoot = join(fixtureRoot, 'repository');

    await mkdir(repositoryRoot);
    await writeFile(
      join(repositoryRoot, 'package.json'),
      '{"name":"test-repository"}',
    );

    await mkdir(join(repositoryRoot, 'src'));
    await writeFile(
      join(repositoryRoot, 'src', 'index.ts'),
      'export const value = 42;',
    );

    const archive = await createArchive();
    const workspace = await createWorkspace();

    await service.extractArchive(archive, workspace);

    await expect(
      readFile(join(workspace.path, 'package.json'), 'utf8'),
    ).resolves.toBe('{"name":"test-repository"}');

    await expect(
      readFile(join(workspace.path, 'src', 'index.ts'), 'utf8'),
    ).resolves.toBe('export const value = 42;');
  });

  it('rejects symbolic links without extracting files', async () => {
    const repositoryRoot = join(fixtureRoot, 'repository');

    await mkdir(repositoryRoot);
    await writeFile(join(repositoryRoot, 'package.json'), '{}');

    await symlink('package.json', join(repositoryRoot, 'package-link.json'));

    const archive = await createArchive();
    const workspace = await createWorkspace();

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Archive entry type is not allowed',
    );

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('rejects an invalid archive without writing files', async () => {
    const workspace = await createWorkspace();

    await expect(
      service.extractArchive(
        Buffer.from('this is not a tar archive'),
        workspace,
      ),
    ).rejects.toThrow();

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('rejects a non-empty workspace', async () => {
    const repositoryRoot = join(fixtureRoot, 'repository');

    await mkdir(repositoryRoot);
    await writeFile(join(repositoryRoot, 'package.json'), '{}');

    const archive = await createArchive();
    const workspace = await createWorkspace();

    await writeFile(join(workspace.path, 'existing.txt'), 'existing');

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Remediation workspace must be empty',
    );

    await expect(
      readFile(join(workspace.path, 'existing.txt'), 'utf8'),
    ).resolves.toBe('existing');
  });

  it('rejects path traversal entries without writing outside the workspace', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/../../escape.txt',
        content: 'malicious content',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow();

    await expect(readdir(workspace.path)).resolves.toEqual([]);

    await expect(
      readFile(join(root, 'escape.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects duplicate archive paths', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/package.json',
        content: '{"name":"first"}',
      },
      {
        path: 'repository/package.json',
        content: '{"name":"second"}',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Archive contains duplicate paths',
    );

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('rejects file and directory path conflicts', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/src',
        content: 'not a directory',
      },
      {
        path: 'repository/src/index.ts',
        content: 'malicious content',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Archive path conflicts with an existing file',
    );

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('rejects archives containing multiple root directories', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/package.json',
        content: '{}',
      },
      {
        path: 'another-repository/package.json',
        content: '{}',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Archive contains multiple root directories',
    );

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('rejects directory entries exceeding maximum depth', async () => {
    const workspace = await createWorkspace();

    const deepPath = [
      'repository',
      ...Array.from({ length: 33 }, () => 'd'),
      'f',
    ].join('/');

    const archive = createRawTar([
      {
        path: deepPath,
        content: 'too deep',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Archive entry exceeds maximum directory depth',
    );

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('rejects archives exceeding the expanded size limit', async () => {
    const workspace = await createWorkspace();

    const header = Buffer.alloc(512);

    header.write('repository/large.bin', 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');

    const declaredSize = 500 * 1024 * 1024 + 1;
    header.write(
      declaredSize.toString(8).padStart(11, '0') + '\0',
      124,
      12,
      'ascii',
    );

    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      checksum.toString(8).padStart(6, '0') + '\0 ',
      148,
      8,
      'ascii',
    );

    const archive = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow();

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('rejects unsupported special file types', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/device',
        type: '3',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Archive entry type is not allowed',
    );

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('cleans partially extracted files when extraction fails', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/package.json',
        content: '{}',
      },
    ]);

    const extractionError = new Error('Simulated extraction failure');

    jest
      .spyOn(service as any, 'extractValidatedArchive')
      .mockImplementation(async (_archive: Buffer, workspacePath: string) => {
        await writeFile(
          join(workspacePath, 'partial-file.txt'),
          'partial content',
        );

        throw extractionError;
      });

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      'Simulated extraction failure',
    );

    await expect(readdir(workspace.path)).resolves.toEqual([]);
  });

  it('extracts valid paths provided by PAX metadata', async () => {
    const workspace = await createWorkspace();

    const longPath = `repository/${'d'.repeat(120)}/file.txt`;

    const archive = createRawTar([
      {
        path: 'repository/PaxHeader',
        type: 'x',
        content: createPaxRecord('path', longPath),
      },
      {
        path: 'repository/file.txt',
        content: 'valid content',
      },
    ]);

    await service.extractArchive(archive, workspace);

    const extractedPath = join(
      workspace.path,
      ...longPath.replace('repository/', '').split('/'),
    );

    await expect(readFile(extractedPath, 'utf8')).resolves.toBe(
      'valid content',
    );

    await rm(workspace.path, { recursive: true, force: true });
  });

  it('rejects unsafe paths provided by PAX metadata', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/PaxHeader',
        type: 'x',
        content: createPaxRecord('path', '../escape.txt'),
      },
      {
        path: 'repository/file.txt',
        content: 'malicious content',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow();

    await expect(readdir(workspace.path)).resolves.toHaveLength(0);

    await rm(workspace.path, { recursive: true, force: true });
  });

  it('extracts files with valid PAX size metadata', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: 'repository/PaxHeader',
        type: 'x',
        content: createPaxRecord('size', '1'),
      },
      {
        path: 'repository/file.txt',
        content: 'x',
      },
    ]);

    await service.extractArchive(archive, workspace);

    await expect(
      readFile(join(workspace.path, 'file.txt'), 'utf8'),
    ).resolves.toBe('x');
  });

  it('extracts valid paths provided by GNU LongPath metadata', async () => {
    const workspace = await createWorkspace();

    const longPath = `repository/${'d'.repeat(120)}/file.txt`;

    const archive = createRawTar([
      {
        path: '././@LongLink',
        type: 'L',
        content: `${longPath}\0`,
      },
      {
        path: 'repository/file.txt',
        content: 'valid content',
      },
    ]);

    await service.extractArchive(archive, workspace);

    const extractedPath = join(
      workspace.path,
      ...longPath.replace('repository/', '').split('/'),
    );

    await expect(readFile(extractedPath, 'utf8')).resolves.toBe(
      'valid content',
    );
  });

  it('rejects path traversal provided by GNU LongPath metadata', async () => {
    const workspace = await createWorkspace();

    const archive = createRawTar([
      {
        path: '././@LongLink',
        type: 'L',
        content: '../escape.txt\0',
      },
      {
        path: 'repository/file.txt',
        content: 'malicious content',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow();

    await expect(readdir(workspace.path)).resolves.toHaveLength(0);
  });

  it('rejects path segments exceeding the filesystem UTF-8 byte limit', async () => {
    const workspace = await createWorkspace();

    const oversizedSegment = 'é'.repeat(128);
    const unsafePath = `repository/${oversizedSegment}/file.txt`;

    const archive = createRawTar([
      {
        path: 'PaxHeaders.0/entry',
        type: 'x',
        content: createPaxRecord('path', unsafePath),
      },
      {
        path: 'repository/placeholder.txt',
        content: 'content',
      },
    ]);

    await expect(service.extractArchive(archive, workspace)).rejects.toThrow(
      /unsafe path segment/i,
    );

    await expect(readdir(workspace.path)).resolves.toHaveLength(0);
  });
});
