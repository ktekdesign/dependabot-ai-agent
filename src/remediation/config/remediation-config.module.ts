import { Module } from '@nestjs/common';

import {
  loadRemediationConfig,
  type RemediationConfig,
} from './remediation.config';

export const REMEDIATION_CONFIG = Symbol('REMEDIATION_CONFIG');

@Module({
  providers: [
    {
      provide: REMEDIATION_CONFIG,
      useFactory: (): RemediationConfig => loadRemediationConfig(),
    },
  ],
  exports: [REMEDIATION_CONFIG],
})
export class RemediationConfigModule {}
