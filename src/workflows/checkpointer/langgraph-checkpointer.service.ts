import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

@Injectable()
export class LangGraphCheckpointerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LangGraphCheckpointerService.name);

  private checkpointer: PostgresSaver | null = null;

  async onModuleInit(): Promise<void> {
    const connectionString =
      process.env.NODE_ENV === 'test'
        ? process.env.TEST_DATABASE_URL
        : process.env.DIRECT_URL;

    if (!connectionString) {
      throw new Error(
        'PostgreSQL connection string for LangGraph is not configured',
      );
    }

    this.checkpointer = PostgresSaver.fromConnString(connectionString);

    await this.checkpointer.setup();

    this.logger.log('LangGraph PostgreSQL checkpointer initialized');
  }

  getCheckpointer(): PostgresSaver {
    if (!this.checkpointer) {
      throw new Error('LangGraph checkpointer has not been initialized');
    }

    return this.checkpointer;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.checkpointer) {
      await this.checkpointer.end();
      this.checkpointer = null;

      this.logger.log('LangGraph checkpointer connection closed');
    }
  }
}
