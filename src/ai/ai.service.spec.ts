import { Test, TestingModule } from '@nestjs/testing';

import { AIService } from './ai.service';
import { AIProviderFactory } from './ai-provider.factory';
import { AIProvider } from './contracts/ai-provider.interface';
import { AIRequest, AIResponse } from './contracts/ai-message.interface';

import { SecurityAnalysisResultSchema } from './schemas/security-analysis-result.schema';
import { RemediationPlanSchema } from './schemas/remediation-plan.schema';

describe('AIService', () => {
  let service: AIService;

  const mockResponse: AIResponse = {
    content: 'Test response',
    provider: 'openai',
    model: 'test-model',
  };

  const mockProvider: jest.Mocked<AIProvider> = {
    generate: jest.fn(),
    generateStructured: jest.fn(),
  };

  const mockFactory = {
    create: jest.fn().mockReturnValue(mockProvider),
  };

  const request: AIRequest = {
    messages: [
      {
        role: 'user',
        content: 'Analyze this vulnerability',
      },
    ],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFactory.create.mockReturnValue(mockProvider);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AIService,
        {
          provide: AIProviderFactory,
          useValue: mockFactory,
        },
      ],
    }).compile();

    service = module.get<AIService>(AIService);
  });

  describe('generate', () => {
    it('should use the default provider', async () => {
      mockProvider.generate.mockResolvedValue(mockResponse);

      await expect(service.generate(request)).resolves.toEqual(mockResponse);

      expect(mockFactory.create).toHaveBeenCalledWith(undefined);
      expect(mockProvider.generate).toHaveBeenCalledWith(request);
    });

    it('should use an explicitly selected provider', async () => {
      mockProvider.generate.mockResolvedValue(mockResponse);

      await service.generate(request, 'anthropic');

      expect(mockFactory.create).toHaveBeenCalledWith('anthropic');
    });

    it('should propagate provider errors', async () => {
      const error = new Error('Provider failure');
      mockProvider.generate.mockRejectedValue(error);

      await expect(service.generate(request)).rejects.toThrow(error);
    });
  });

  describe('analyzeSecurity', () => {
    it('should request structured security analysis', async () => {
      const result = {
        riskLevel: 'HIGH',
        exploitability: 'PROOF_OF_CONCEPT',
        confidence: 0.95,
        summary: 'A vulnerability was identified.',
        impact: 'Potential remote code execution.',
        remediation: {
          strategy: 'UPGRADE',
          targetVersion: '2.0.0',
          rationale: 'Upgrade to a patched version.',
          steps: ['Update dependency'],
        },
        compatibility: {
          breakingChangeRisk: 'LOW',
          notes: 'No known breaking changes.',
        },
        evidence: [
          {
            source: 'CVE',
            reference: 'CVE-2026-1234',
            finding: 'A proof of concept exists.',
          },
        ],
        requiresHumanReview: false,
        humanReviewReason: null,
      };

      mockProvider.generateStructured.mockResolvedValue(result);

      await expect(service.analyzeSecurity(request)).resolves.toEqual(result);

      expect(mockFactory.create).toHaveBeenCalledWith(undefined);
      expect(mockProvider.generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('untrusted data'),
            }),
          ]),
        }),
        SecurityAnalysisResultSchema,
      );
    });

    it('should use an explicitly selected provider', async () => {
      const result = {
        riskLevel: 'LOW',
        exploitability: 'UNKNOWN',
        confidence: 0.8,
        summary: 'Low risk.',
        impact: 'Limited impact.',
        remediation: {
          strategy: 'MITIGATE',
          targetVersion: null,
          rationale: 'Mitigation is sufficient.',
          steps: ['Apply mitigation'],
        },
        compatibility: {
          breakingChangeRisk: 'LOW',
          notes: 'No compatibility concerns.',
        },
        evidence: [
          {
            source: 'OTHER',
            reference: 'internal',
            finding: 'Limited exposure.',
          },
        ],
        requiresHumanReview: false,
        humanReviewReason: null,
      };

      mockProvider.generateStructured.mockResolvedValue(result);

      await service.analyzeSecurity(request, 'anthropic');

      expect(mockFactory.create).toHaveBeenCalledWith('anthropic');
    });

    it('should propagate structured provider errors', async () => {
      const error = new Error('Structured output failure');
      mockProvider.generateStructured.mockRejectedValue(error);

      await expect(service.analyzeSecurity(request)).rejects.toThrow(error);
    });
  });

  describe('createRemediationPlan', () => {
    it('should request a structured remediation plan', async () => {
      const result = {
        summary: 'Upgrade vulnerable dependency.',
        riskLevel: 'LOW',
        dependencyUpdates: [
          {
            packageName: 'example-package',
            currentVersion: '1.0.0',
            targetVersion: '2.0.0',
            packageManager: 'npm',
            dependencyType: 'PRODUCTION',
            rationale: 'Fixes the vulnerability.',
          },
        ],
        fileChanges: [
          {
            path: 'package.json',
            operation: 'MODIFY',
            instructions: 'Update the dependency version.',
            rationale: 'Apply the security fix.',
          },
        ],
        validationChecks: ['INSTALL', 'TEST', 'DEPENDENCY_AUDIT'],
        successCriteria: ['All tests pass.'],
        pullRequest: {
          title: 'fix: remediate dependency vulnerability',
          description: 'Updates the vulnerable dependency.',
        },
      };

      mockProvider.generateStructured.mockResolvedValue(result);

      await expect(
        service.createRemediationPlan(request, 'LOW'),
      ).resolves.toEqual(
        expect.objectContaining({
          riskLevel: 'LOW',
          validationChecks: expect.arrayContaining([
            'INSTALL',
            'TEST',
            'DEPENDENCY_AUDIT',
          ]),
        }),
      );

      expect(mockProvider.generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('untrusted data'),
            }),
          ]),
        }),
        RemediationPlanSchema,
      );
    });

    it('should propagate structured provider errors', async () => {
      const error = new Error('Remediation plan failure');
      mockProvider.generateStructured.mockRejectedValue(error);

      await expect(
        service.createRemediationPlan(request, 'LOW'),
      ).rejects.toThrow(error);
    });
  });
  it('should enforce authoritative risk level and mandatory checks', async () => {
    const modelPlan = {
      summary: 'Upgrade vulnerable dependency.',
      riskLevel: 'LOW',
      dependencyUpdates: [],
      fileChanges: [],
      validationChecks: ['INSTALL'],
      successCriteria: ['All tests pass.'],
      pullRequest: {
        title: 'fix: remediate dependency',
        description: 'Security remediation.',
      },
    };

    mockProvider.generateStructured.mockResolvedValue(modelPlan);

    const result = await service.createRemediationPlan(request, 'CRITICAL');

    expect(result.riskLevel).toBe('CRITICAL');

    expect(result.validationChecks).toEqual(
      expect.arrayContaining([
        'INSTALL',
        'TEST',
        'DEPENDENCY_AUDIT',
        'LINT',
        'TYPECHECK',
        'BUILD',
      ]),
    );
  });
});
