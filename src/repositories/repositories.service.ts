import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

interface SyncRepositoryInput {
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
}

@Injectable()
export class RepositoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async syncRepository(input: SyncRepositoryInput) {
    return this.prisma.repository.upsert({
      where: {
        fullName: input.fullName,
      },
      create: {
        githubId: BigInt(input.githubId),
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        monitoringStatus: 'PENDING',
      },
      update: {
        githubId: BigInt(input.githubId),
        owner: input.owner,
        name: input.name,
        monitoringStatus: 'ENABLED',
        lastSyncedAt: new Date(),
      },
    });
  }

  async findAll() {
    return this.prisma.repository.findMany({
      orderBy: {
        fullName: 'asc',
      },
    });
  }

  async updateMonitoringStatus(
    fullName: string,
    status: 'PENDING' | 'ENABLED' | 'NOT_ENABLED' | 'ERROR',
  ) {
    return this.prisma.repository.update({
      where: { fullName },
      data: {
        monitoringStatus: status,
        ...(status === 'ENABLED' && {
          lastSyncedAt: new Date(),
        }),
      },
    });
  }
}
