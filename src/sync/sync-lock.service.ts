import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class SyncLockService implements OnModuleDestroy {
  private readonly pool: Pool;

  private readonly lockKey1 = 2026;
  private readonly lockKey2 = 1118;

  constructor() {
    const connectionString =
      process.env.NODE_ENV === 'test'
        ? process.env.TEST_DATABASE_URL
        : process.env.DIRECT_URL;

    if (!connectionString) {
      throw new Error('Database connection URL is missing');
    }

    this.pool = new Pool({
      connectionString,
      max: 2,
    });
  }

  async acquire(): Promise<PoolClient | null> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [this.lockKey1, this.lockKey2],
      );

      if (!result.rows[0].locked) {
        client.release();
        return null;
      }

      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async release(client: PoolClient): Promise<void> {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        this.lockKey1,
        this.lockKey2,
      ]);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
