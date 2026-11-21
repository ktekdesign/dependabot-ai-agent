import { Module } from '@nestjs/common';

import { RemediationConfigModule } from './config/remediation-config.module';
import { DockerWorkspaceExecutor } from './workspace/docker-workspace.executor';
import { WorkspaceService } from './workspace/workspace.service';
import { WORKSPACE_EXECUTOR } from './workspace/workspace-executor.interface';

@Module({
  imports: [RemediationConfigModule],
  providers: [
    WorkspaceService,
    DockerWorkspaceExecutor,
    {
      provide: WORKSPACE_EXECUTOR,
      useExisting: DockerWorkspaceExecutor,
    },
  ],
  exports: [WorkspaceService, WORKSPACE_EXECUTOR],
})
export class RemediationModule {}
