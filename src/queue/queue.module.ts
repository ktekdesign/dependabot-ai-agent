import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueService } from './queue.service';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null,
      },
    }),
    BullModule.registerQueue({
      name: 'security-analysis',
    }),
  ],
  providers: [QueueService],
  exports: [BullModule, QueueService],
})
export class QueueModule {}
