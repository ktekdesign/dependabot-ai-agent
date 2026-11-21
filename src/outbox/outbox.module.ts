import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { OutboxService } from './outbox.service';
import { OutboxScheduler } from './outbox.scheduler';

@Module({
  imports: [QueueModule],
  providers: [OutboxService, OutboxScheduler],
  exports: [OutboxService],
})
export class OutboxModule {}
