import 'dotenv/config';

process.env.NODE_ENV = 'test';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not configured');
}
