import 'dotenv/config';

import { END, START, StateGraph, Annotation } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { LangGraphCheckpointerService } from '../src/workflows/checkpointer/langgraph-checkpointer.service';

const TestState = Annotation.Root({
  input: Annotation<string>(),
  validated: Annotation<boolean>(),
  result: Annotation<string>(),
});

describe('LangGraph resume (integration)', () => {
  const checkpointerService = new LangGraphCheckpointerService();

  beforeAll(async () => {
    await checkpointerService.onModuleInit();
  });

  afterAll(async () => {
    await checkpointerService.onModuleDestroy();
  });

  it('should resume from the last checkpoint after a node failure', async () => {
    const threadId = randomUUID();

    let validationExecutions = 0;
    let preparationExecutions = 0;

    const graph = new StateGraph(TestState)
      .addNode('validate', async (state) => {
        validationExecutions++;

        if (!state.input) {
          throw new Error('Missing input');
        }

        return { validated: true };
      })
      .addNode('prepare', async (state) => {
        preparationExecutions++;

        if (preparationExecutions === 1) {
          throw new Error('Simulated interruption');
        }

        return {
          result: `Processed: ${state.input}`,
        };
      })
      .addEdge(START, 'validate')
      .addEdge('validate', 'prepare')
      .addEdge('prepare', END)
      .compile({
        checkpointer: checkpointerService.getCheckpointer(),
      });

    const config = {
      configurable: {
        thread_id: threadId,
      },
    };

    await expect(
      graph.invoke(
        {
          input: 'security-alert-123',
          validated: false,
          result: '',
        },
        config,
      ),
    ).rejects.toThrow('Simulated interruption');

    const checkpointAfterFailure = await graph.getState(config);

    expect(checkpointAfterFailure.values.validated).toBe(true);
    expect(checkpointAfterFailure.next).toContain('prepare');

    const resumed = await graph.invoke(null, config);

    expect(resumed.result).toBe('Processed: security-alert-123');
    expect(validationExecutions).toBe(1);
    expect(preparationExecutions).toBe(2);
  });
});
