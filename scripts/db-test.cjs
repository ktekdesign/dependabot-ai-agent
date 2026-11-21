require('dotenv/config');

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL,
  log: ['error', 'warn'],
});

async function main() {
  console.log('Testing Supabase session pooler on port 5432...');

  const result = await prisma.$queryRaw`
    SELECT current_user, current_database(), NOW()
  `;

  console.log('Connection successful:', result);
}

main()
  .catch((error) => {
    console.error('Connection failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
