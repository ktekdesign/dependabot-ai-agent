import { Test, TestingModule } from '@nestjs/testing';

import {
  REMEDIATION_CONFIG,
  RemediationConfigModule,
} from './remediation-config.module';

describe('RemediationConfigModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [RemediationConfigModule],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('provides validated remediation configuration', () => {
    const config = module.get(REMEDIATION_CONFIG);

    expect(config.docker.image).toBe('dependabot-remediation-node:22');
    expect(config.docker.executionTimeoutMs).toBe(600_000);
    expect(config.docker.memory).toBe('1g');
  });
});
