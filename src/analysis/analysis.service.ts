import { Injectable, NotFoundException } from '@nestjs/common';
import { AnalysisStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';

const EXPECTED_EVENT_TYPE = 'SECURITY_ALERT_DETECTED';
const LEASE_DURATION_MINUTES = 5;

export interface SecurityAnalysisWorkflowInput {
  eventId: string;
  securityAlertId: string;
  repositoryFullName: string;
  alertNumber: number;
  fingerprint: string;
  alertSnapshot: Record<string, unknown>;
}

export type AnalysisAcquisition =
  | {
      acquired: true;
      reason: 'ACQUIRED';
      analysisId: string;
      processingToken: string;
    }
  | {
      acquired: false;
      reason: 'ALREADY_COMPLETED' | 'ALREADY_SKIPPED' | 'ALREADY_PROCESSING';
    };

@Injectable()
export class AnalysisService {
  constructor(private readonly prisma: PrismaService) {}

  async registerPendingAnalysis(eventId: string) {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.outboxEvent.findUnique({
        where: { id: eventId },
      });

      if (!event) {
        throw new NotFoundException(`Outbox event ${eventId} not found`);
      }

      if (event.eventType !== EXPECTED_EVENT_TYPE) {
        throw new Error(`Unsupported event type: ${event.eventType}`);
      }

      const payload = event.payload;

      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error('Invalid outbox event payload');
      }

      const data = payload as Record<string, Prisma.JsonValue>;

      if (
        data.schemaVersion !== 1 ||
        typeof data.securityAlertId !== 'string' ||
        typeof data.repositoryFullName !== 'string' ||
        data.repositoryFullName.length === 0 ||
        typeof data.alertNumber !== 'number' ||
        !Number.isInteger(data.alertNumber) ||
        data.alertNumber <= 0 ||
        typeof data.fingerprint !== 'string' ||
        data.fingerprint.length === 0 ||
        typeof data.alertSnapshot !== 'object' ||
        data.alertSnapshot === null ||
        Array.isArray(data.alertSnapshot)
      ) {
        throw new Error('Invalid security alert event structure');
      }

      const securityAlertId = data.securityAlertId;
      const alertSnapshot = data.alertSnapshot as Prisma.InputJsonValue;

      const alert = await tx.securityAlert.findUnique({
        where: { id: securityAlertId },
        select: { id: true },
      });

      if (!alert) {
        throw new NotFoundException(
          `Security alert ${securityAlertId} not found`,
        );
      }

      const analysis = await tx.securityAnalysis.upsert({
        where: {
          outboxEventId: event.id,
        },
        create: {
          outboxEventId: event.id,
          securityAlertId: alert.id,
          alertSnapshot,
          status: AnalysisStatus.PENDING,
        },
        update: {},
      });

      return {
        analysis,
        workflowInput: {
          eventId: event.id,
          securityAlertId: alert.id,
          repositoryFullName: data.repositoryFullName,
          alertNumber: data.alertNumber,
          fingerprint: data.fingerprint,
          alertSnapshot: data.alertSnapshot as Record<string, unknown>,
        } satisfies SecurityAnalysisWorkflowInput,
      };
    });
  }

  async acquireAnalysis(analysisId: string): Promise<AnalysisAcquisition> {
    const processingToken = randomUUID();

    const acquired = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        UPDATE security_analyses
        SET
          status = 'PROCESSING'::"AnalysisStatus",
          "processingToken" = ${processingToken},
          "processingLeaseUntil" =
            NOW() + (${LEASE_DURATION_MINUTES} * INTERVAL '1 minute'),
          attempts = attempts + 1,
          "startedAt" = NOW(),
          "lastError" = NULL,
          "updatedAt" = NOW()
        WHERE
          id = ${analysisId}::uuid
          AND (
            status IN (
              'PENDING'::"AnalysisStatus",
              'FAILED'::"AnalysisStatus"
            )
            OR (
              status = 'PROCESSING'::"AnalysisStatus"
              AND (
                "processingLeaseUntil" IS NULL
                OR "processingLeaseUntil" <= NOW()
              )
            )
          )
        RETURNING id
      `,
    );

    if (acquired.length > 0) {
      return {
        acquired: true,
        reason: 'ACQUIRED',
        analysisId: acquired[0].id,
        processingToken,
      };
    }

    const analysis = await this.prisma.securityAnalysis.findUnique({
      where: { id: analysisId },
      select: { status: true },
    });

    if (!analysis) {
      throw new NotFoundException(`Security analysis ${analysisId} not found`);
    }

    switch (analysis.status) {
      case AnalysisStatus.COMPLETED:
        return { acquired: false, reason: 'ALREADY_COMPLETED' };

      case AnalysisStatus.SKIPPED:
        return { acquired: false, reason: 'ALREADY_SKIPPED' };

      case AnalysisStatus.PROCESSING:
        return { acquired: false, reason: 'ALREADY_PROCESSING' };

      default:
        throw new Error(
          `Could not acquire security analysis in status ${analysis.status}`,
        );
    }
  }

  async completeAnalysis(
    analysisId: string,
    processingToken: string,
    result: unknown,
  ): Promise<boolean> {
    const serializedResult =
      result === undefined
        ? Prisma.JsonNull
        : (JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue);

    const updated = await this.prisma.securityAnalysis.updateMany({
      where: {
        id: analysisId,
        status: AnalysisStatus.PROCESSING,
        processingToken,
      },
      data: {
        status: AnalysisStatus.COMPLETED,
        result: serializedResult,
        completedAt: new Date(),
        processingToken: null,
        processingLeaseUntil: null,
        lastError: null,
      },
    });

    return updated.count === 1;
  }

  async failAnalysis(
    analysisId: string,
    processingToken: string,
    error: unknown,
  ): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);

    const updated = await this.prisma.securityAnalysis.updateMany({
      where: {
        id: analysisId,
        status: AnalysisStatus.PROCESSING,
        processingToken,
      },
      data: {
        status: AnalysisStatus.FAILED,
        lastError: message.slice(0, 4000),
        processingToken: null,
        processingLeaseUntil: null,
      },
    });

    return updated.count === 1;
  }

  async findExpiredProcessingAnalyses(limit = 50) {
    return this.prisma.securityAnalysis.findMany({
      where: {
        status: AnalysisStatus.PROCESSING,
        processingLeaseUntil: {
          lte: new Date(),
        },
      },
      select: {
        id: true,
        outboxEventId: true,
        processingLeaseUntil: true,
      },
      orderBy: {
        processingLeaseUntil: 'asc',
      },
      take: limit,
    });
  }

  async renewAnalysisLease(
    analysisId: string,
    processingToken: string,
  ): Promise<boolean> {
    const updated = await this.prisma.securityAnalysis.updateMany({
      where: {
        id: analysisId,
        status: AnalysisStatus.PROCESSING,
        processingToken,
        processingLeaseUntil: {
          gt: new Date(),
        },
      },
      data: {
        processingLeaseUntil: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    return updated.count === 1;
  }
}
