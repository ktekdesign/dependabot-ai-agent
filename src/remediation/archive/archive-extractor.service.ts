import { Injectable } from '@nestjs/common';

import { createReadStream, createWriteStream } from 'node:fs';

import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { Readable, Transform } from 'node:stream';

import { pipeline } from 'node:stream/promises';

import { createGunzip } from 'node:zlib';

import { extract, Parser, type ReadEntry } from 'tar';

import { join } from 'node:path';

import {
  WorkspaceService,
  type RemediationWorkspace,
} from '../workspace/workspace.service';

const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DIRECTORY_DEPTH = 32;
const MAX_DECOMPRESSION_RATIO = 200;
const MAX_META_ENTRY_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;
const MAX_DECOMPRESSED_ARCHIVE_BYTES = 600 * 1024 * 1024;

interface ArchiveValidationState {
  rootDirectory: string | null;
  entryCount: number;
  expandedBytes: number;
  explicitPaths: Set<string>;
  filePaths: Set<string>;
  implicitDirectories: Set<string>;
}

@Injectable()
export class ArchiveExtractorService {
  constructor(private readonly workspaceService: WorkspaceService) {}

  async extractArchive(
    archive: Buffer,
    workspace: RemediationWorkspace,
  ): Promise<void> {
    if (!Buffer.isBuffer(archive)) {
      throw new Error('Repository archive must be a Buffer');
    }

    if (archive.length === 0 || archive.length > MAX_COMPRESSED_BYTES) {
      throw new Error('Repository archive size is invalid');
    }

    const workspacePath = await this.workspaceService.validateWorkspace(
      workspace.path,
      workspace.analysisId,
    );

    const existingEntries = await readdir(workspacePath);

    if (existingEntries.length > 0) {
      throw new Error('Remediation workspace must be empty');
    }

    let temporaryDirectory: string | undefined;
    let operationError: unknown;

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'dependabot-archive-'));

      await chmod(temporaryDirectory, 0o700);

      const archivePath = join(temporaryDirectory, 'repository.tar');

      await this.decompressArchive(archive, archivePath);

      await this.validateArchive(archivePath);

      try {
        await this.extractValidatedArchive(archivePath, workspacePath);
      } catch (extractionError) {
        try {
          await this.cleanupWorkspace(workspacePath);
        } catch (cleanupError) {
          throw new AggregateError(
            [extractionError, cleanupError],
            'Archive extraction failed and workspace cleanup was unsuccessful',
          );
        }

        throw extractionError;
      }
    } catch (error) {
      operationError = error;
    }

    const cleanupErrors: unknown[] = [];

    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, {
          recursive: true,
          force: false,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (operationError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        'Archive processing failed and temporary files could not be cleaned',
      );
    }

    if (operationError) {
      throw operationError;
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Failed to clean temporary archive files',
      );
    }
  }

  private async decompressArchive(
    archive: Buffer,
    destinationPath: string,
  ): Promise<void> {
    if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
      throw new Error('Repository archive must use gzip compression');
    }

    let decompressedBytes = 0;

    const maximumBytesByRatio = archive.length * MAX_DECOMPRESSION_RATIO;

    const sizeLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        decompressedBytes += chunk.length;

        if (decompressedBytes > MAX_DECOMPRESSED_ARCHIVE_BYTES) {
          callback(new Error('Archive exceeds maximum decompressed size'));
          return;
        }

        if (decompressedBytes > maximumBytesByRatio) {
          callback(new Error('Archive exceeds maximum decompression ratio'));
          return;
        }

        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.from([archive]),
      createGunzip(),
      sizeLimiter,
      createWriteStream(destinationPath, {
        flags: 'wx',
        mode: 0o600,
      }),
    );

    if (decompressedBytes === 0) {
      throw new Error('Repository archive is empty');
    }
  }

  private async validateArchive(archivePath: string): Promise<void> {
    const state: ArchiveValidationState = {
      rootDirectory: null,
      entryCount: 0,
      expandedBytes: 0,
      explicitPaths: new Set<string>(),
      filePaths: new Set<string>(),
      implicitDirectories: new Set<string>(),
    };

    const parser = new Parser({
      strict: true,
      maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    });

    const input = createReadStream(archivePath);

    await new Promise<void>((resolve, reject) => {
      let validationError: Error | undefined;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        input.destroy();
        reject(error);
      };

      parser.once('error', fail);
      input.once('error', fail);

      parser.once('end', () => {
        if (settled) {
          return;
        }

        settled = true;

        if (validationError) {
          reject(validationError);
          return;
        }

        if (!state.rootDirectory || state.entryCount === 0) {
          reject(new Error('Repository archive is empty or invalid'));
          return;
        }

        resolve();
      });

      parser.on('entry', (entry: ReadEntry) => {
        try {
          this.validateEntry(entry, state);
        } catch (error) {
          validationError =
            error instanceof Error
              ? error
              : new Error('Archive entry validation failed');

          parser.abort(validationError);
        } finally {
          entry.resume();
        }
      });

      input.pipe(parser);
    });
  }

  private validateEntry(entry: ReadEntry, state: ArchiveValidationState): void {
    if (entry.invalid || entry.unsupported || entry.meta) {
      throw new Error('Archive contains an invalid or unsupported entry');
    }

    if (
      entry.type !== 'File' &&
      entry.type !== 'OldFile' &&
      entry.type !== 'Directory'
    ) {
      throw new Error(`Archive entry type is not allowed: ${entry.type}`);
    }

    if (
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      Buffer.byteLength(entry.path, 'utf8') > MAX_PATH_LENGTH
    ) {
      throw new Error('Archive entry path is invalid');
    }

    const normalizedPath = this.validateAndNormalizePath(entry.path);

    const segments = normalizedPath.split('/');
    const rootDirectory = segments[0];

    if (!state.rootDirectory) {
      state.rootDirectory = rootDirectory;
    } else if (state.rootDirectory !== rootDirectory) {
      throw new Error('Archive contains multiple root directories');
    }

    const relativeSegments = segments.slice(1);

    if (relativeSegments.length === 0) {
      if (entry.type !== 'Directory') {
        throw new Error('Archive root entry must be a directory');
      }

      if (!Number.isSafeInteger(entry.size) || entry.size !== 0) {
        throw new Error('Archive root directory has an invalid size');
      }

      if (state.explicitPaths.has(rootDirectory)) {
        throw new Error('Archive contains a duplicate root directory');
      }

      state.explicitPaths.add(rootDirectory);
      state.entryCount++;

      if (state.entryCount > MAX_ENTRIES) {
        throw new Error('Archive contains too many entries');
      }

      return;
    }

    const normalizedKey = relativeSegments
      .map((segment) => segment.normalize('NFC').toLowerCase())
      .join('/');

    if (relativeSegments.length > MAX_DIRECTORY_DEPTH) {
      throw new Error('Archive entry exceeds maximum directory depth');
    }

    if (state.explicitPaths.has(normalizedKey)) {
      throw new Error('Archive contains duplicate paths');
    }

    const ancestors: string[] = [];

    for (let index = 1; index < relativeSegments.length; index++) {
      ancestors.push(
        relativeSegments
          .slice(0, index)
          .map((segment) => segment.normalize('NFC').toLowerCase())
          .join('/'),
      );
    }

    for (const ancestor of ancestors) {
      if (state.filePaths.has(ancestor)) {
        throw new Error('Archive path conflicts with an existing file');
      }

      state.implicitDirectories.add(ancestor);
    }

    if (entry.type === 'File' || entry.type === 'OldFile') {
      if (state.implicitDirectories.has(normalizedKey)) {
        throw new Error('Archive file conflicts with an existing directory');
      }

      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error('Archive file has an invalid size');
      }

      state.expandedBytes += entry.size;

      if (state.expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('Archive exceeds maximum expanded size');
      }

      state.filePaths.add(normalizedKey);
    } else {
      if (state.filePaths.has(normalizedKey)) {
        throw new Error('Archive directory conflicts with an existing file');
      }

      if (entry.size !== 0) {
        throw new Error('Archive directory has an invalid size');
      }
    }

    state.explicitPaths.add(normalizedKey);
    state.entryCount++;

    if (state.entryCount > MAX_ENTRIES) {
      throw new Error('Archive contains too many entries');
    }

    // Keep this value explicit: it documents that the path
    // has been validated after removing the repository root.
  }

  private validateAndNormalizePath(rawPath: string): string {
    if (
      rawPath.startsWith('/') ||
      rawPath.startsWith('\\') ||
      rawPath.includes('\\') ||
      rawPath.includes('\0') ||
      /[\u0000-\u001f\u007f]/.test(rawPath) ||
      /^[a-zA-Z]:/.test(rawPath)
    ) {
      throw new Error('Archive contains an unsafe path');
    }

    const pathWithoutTrailingSlash = rawPath.endsWith('/')
      ? rawPath.slice(0, -1)
      : rawPath;

    if (
      pathWithoutTrailingSlash.length === 0 ||
      pathWithoutTrailingSlash.length > MAX_PATH_LENGTH
    ) {
      throw new Error('Archive entry path is invalid');
    }

    const segments = pathWithoutTrailingSlash.split('/');

    if (segments.some((segment) => segment.length === 0)) {
      throw new Error('Archive path contains empty segments');
    }

    for (const segment of segments) {
      if (
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_LENGTH ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        segment.includes(':')
      ) {
        throw new Error('Archive contains an unsafe path segment');
      }
    }

    return segments.join('/');
  }

  private async extractValidatedArchive(
    archivePath: string,
    workspacePath: string,
  ): Promise<void> {
    await extract({
      file: archivePath,
      cwd: workspacePath,
      strict: true,
      strip: 1,
      preservePaths: false,
      preserveOwner: false,
      unlink: true,
      maxDepth: MAX_DIRECTORY_DEPTH,
      maxMetaEntrySize: MAX_META_ENTRY_BYTES,
      noMtime: true,
      umask: 0o077,
      dmode: 0o700,
      fmode: 0o600,
    });
  }

  private async cleanupWorkspace(workspacePath: string): Promise<void> {
    const entries = await readdir(workspacePath);

    const results = await Promise.allSettled(
      entries.map((entry) =>
        rm(join(workspacePath, entry), {
          recursive: true,
          force: false,
        }),
      ),
    );

    const cleanupErrors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result) => result.reason);

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Failed to clean ${cleanupErrors.length} workspace entries`,
      );
    }
  }
}
