import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../config/env';

/**
 * Object storage port. Local disk in development; in production the adapter targets S3
 * with SSE-KMS and the API hands out short-lived pre-signed URLs instead of streaming.
 */
export interface DocumentStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
}

export class LocalDocumentStorage implements DocumentStorage {
  private readonly root: string;

  constructor({ config }: { config: AppConfig }) {
    this.root = path.resolve(config.storageDir);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    // Keys are generated server-side, but never trust a path: block traversal outright.
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, { mode: 0o600 });
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}
