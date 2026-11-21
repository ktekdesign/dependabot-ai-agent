import { END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { AIService } from '../../ai/ai.service';
import { SecurityAnalysisState } from './security-analysis.state';
import {
  createAnalyzeSecurityNode,
  createRemediationPlanNode,
  prepareAnalysisNode,
  validateInputNode,
} from './security-analysis.nodes';

export function createSecurityAnalysisGraph(
  checkpointer?: PostgresSaver,
  aiService?: AIService,
) {
  const builder = new StateGraph(SecurityAnalysisState)
    .addNode('validate_input', validateInputNode)
    .addNode('prepare_analysis', prepareAnalysisNode)
    .addEdge(START, 'validate_input')
    .addEdge('validate_input', 'prepare_analysis');

  if (aiService) {
    builder
      .addNode('analyze_security', createAnalyzeSecurityNode(aiService))
      .addNode('create_remediation_plan', createRemediationPlanNode(aiService))
      .addEdge('prepare_analysis', 'analyze_security')
      .addEdge('analyze_security', 'create_remediation_plan')
      .addEdge('create_remediation_plan', END);
  } else {
    builder.addEdge('prepare_analysis', END);
  }

  return checkpointer ? builder.compile({ checkpointer }) : builder.compile();
}
