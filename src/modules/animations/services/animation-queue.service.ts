import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// pg-boss é CJS (`module.exports =`) e o projeto não usa esModuleInterop:
// o default import viraria `undefined` em runtime. import-equals é o formato correto aqui.
import PgBoss = require('pg-boss');

export const QUEUES = {
  AI_GENERATE: 'ai.generate',
  AI_POLL: 'ai.poll',
  MEDIA_INGEST: 'media.ingest',
  RENDER_EXPORT: 'render.export',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Fila pg-boss sobre o Postgres existente (TDD ADR-01) — interface estreita
 * (QueuePort) para permitir troca de driver (BullMQ/Redis) sem tocar consumers.
 */
@Injectable()
export class AnimationQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnimationQueueService.name);
  private boss: PgBoss | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('ANIMATIONS_ENABLED') === 'false') return;
    const host = this.config.get('DB_HOST', 'localhost');
    const port = this.config.get('DB_PORT', '5432');
    const user = this.config.get('DB_USERNAME', 'postgres');
    const password = this.config.get('DB_PASSWORD', '');
    const database = this.config.get('DB_DATABASE', 'flyer');
    this.boss = new PgBoss({
      connectionString: `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`,
      schema: 'pgboss',
    });
    this.boss.on('error', (err) => this.logger.error(`pg-boss: ${err.message}`));
    await this.boss.start();
    this.logger.log('pg-boss iniciado');
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }

  async publish(
    queue: QueueName,
    data: Record<string, unknown>,
    options: { startAfterSeconds?: number; singletonKey?: string } = {},
  ): Promise<string | null> {
    if (!this.boss) throw new Error('Fila não inicializada');
    return this.boss.send(queue, data, {
      startAfter: options.startAfterSeconds,
      singletonKey: options.singletonKey,
      retryLimit: 3,
      retryBackoff: true,
      // jobs pesados expirados voltam para a fila (retomada pós-restart do worker)
      expireInSeconds: 15 * 60,
    });
  }

  /** Consumo com gate: `admit` é consultado antes de cada fetch (Admission Control, TDD §6.5). */
  async subscribe<T extends object>(
    queue: QueueName,
    concurrency: number,
    handler: (data: T, jobId: string) => Promise<void>,
    admit: () => boolean = () => true,
  ): Promise<void> {
    if (!this.boss) throw new Error('Fila não inicializada');
    await this.boss.work<T>(
      queue,
      { teamSize: concurrency, teamConcurrency: concurrency, newJobCheckIntervalSeconds: 2 },
      async (job) => {
        if (!admit()) {
          // devolve o job para a fila sem executar — fica `queued` (retry do pg-boss)
          throw new Error('resource_guard_reject');
        }
        await handler(job.data, job.id);
      },
    );
  }
}
