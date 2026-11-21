import 'dotenv/config';
import { Pool } from 'pg';
import { SyncLockService } from '../src/sync/sync-lock.service';

describe('SyncLockService integration', () => {
  let pool: Pool;
  let lockService: SyncLockService;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';

    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });

    lockService = new SyncLockService();
  });

  afterAll(async () => {
    await lockService.onModuleDestroy();
    await pool.end();
  });

  it('should prevent a second connection from acquiring the same lock', async () => {
    const first = await lockService.acquire();

    expect(first).not.toBeNull();

    const second = await pool.connect();

    try {
      const result = await second.query(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [2026, 1118],
      );

      expect(result.rows[0].locked).toBe(false);
    } finally {
      second.release();
      await lockService.release(first!);
    }
  });

  it('should allow another connection to acquire the lock after release', async () => {
    const first = await lockService.acquire();

    expect(first).not.toBeNull();

    await lockService.release(first!);

    const second = await pool.connect();

    try {
      const result = await second.query(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [2026, 1118],
      );

      expect(result.rows[0].locked).toBe(true);

      await second.query('SELECT pg_advisory_unlock($1, $2)', [2026, 1118]);
    } finally {
      second.release();
    }
  });
});
