require('dotenv/config');

const { Queue } = require('bullmq');

async function main() {
  const queue = new Queue('security-analysis', {
    connection: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
    },
  });

  try {
    await queue.waitUntilReady();

    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
    );

    console.log('BullMQ connected to Redis!');
    console.log('Queue:', queue.name);
    console.log('Job counts:', counts);
  } finally {
    await queue.close();
  }
}

main().catch((error) => {
  console.error('Queue connection failed:', error.message);
  process.exitCode = 1;
});
