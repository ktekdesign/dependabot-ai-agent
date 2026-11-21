import { Global, Module } from '@nestjs/common';
import { LangGraphCheckpointerService } from './langgraph-checkpointer.service';

@Global()
@Module({
  providers: [LangGraphCheckpointerService],
  exports: [LangGraphCheckpointerService],
})
export class LangGraphCheckpointerModule {}
