import { Test, TestingModule } from '@nestjs/testing';

import { RemediationModule } from './remediation.module';
import { DockerWorkspaceExecutor } from './workspace/docker-workspace.executor';
import { WORKSPACE_EXECUTOR } from './workspace/workspace-executor.interface';

describe('RemediationModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [RemediationModule],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('provides DockerWorkspaceExecutor through the workspace executor token', () => {
    const executor = module.get(WORKSPACE_EXECUTOR);
    const dockerExecutor = module.get(DockerWorkspaceExecutor);

    expect(executor).toBeInstanceOf(DockerWorkspaceExecutor);
    expect(executor).toBe(dockerExecutor);
  });
});
