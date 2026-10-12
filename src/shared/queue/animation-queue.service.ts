import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// pg-boss é CJS (`module.exports =`) e o projeto não usa esModuleInterop:
// o default import viraria `undefined` em runtime. import-equals é o formato correto aqui.
import PgBoss = require('pg-boss');
import type { EntityManager, QueryResult } from 'typeorm';

export const QUEUES = {
  AI_GENERATE: 'ai.generate',
  AI_POLL: 'ai.poll',
  RENDER_EXPORT: 'render.export',
  /** Comerciais com mascote (plano §6.4): chamadas de LLM (roteiro). */
  MC_LLM: 'mc.llm',
  /** Comerciais com mascote (plano §6.4): geração de imagens (kit do personagem, keyframes). */
  MC_IMAGE: 'mc.image',
  /** Comerciais (plano §6.4): TTS síncrono por fala (concorrência 4). */
  MC_TTS: 'mc.tts',
  /** Comerciais (plano §6.4): submit de jobs assíncronos de vídeo/lipsync (I/O, concorrência 8). */
  MC_SUBMIT: 'mc.submit',
  /** Comerciais (plano §6.4): polling de status do provider — NUNCA gated pelo ResourceGuard. */
  MC_POLL: 'mc.poll',
  /** Comerciais (plano §6.4): download/validação do vídeo do provider (pesado, gate de recursos). */
  MC_INGEST: 'mc.ingest',
  /** Comerciais (plano §6.4): montagem final ffmpeg (concorrência 1, gate de recursos). */
  MC_FFMPEG: 'mc.ffmpeg',
  /**
   * Comerciais (change video-formatos-personagem, tarefa 6.5): render da
   * composição Remotion do F2 (navegador headless — concorrência 1, gate de
   * recursos, expiração própria de 900 s).
   */
  MC_RENDER: 'mc.render',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Jobs pesados expirados voltam para a fila (retomada pós-restart do worker). */
export const DEFAULT_EXPIRE_IN_SECONDS = 15 * 60;

export interface PublishOptions {
  startAfterSeconds?: number;
  singletonKey?: string;
  /** Tempo máximo de execução antes do job voltar à fila (default 900s). */
  expireInSeconds?: number;
  /**
   * Transação TypeORM do chamador: o INSERT do job entra NA MESMA transação e
   * só fica visível ao worker no COMMIT (enfileiramento transacional). Sem
   * isso o pg-boss grava pela própria conexão e o worker pode consumir o job
   * ANTES do commit — não acha o step criado/enfileirado nessa transação,
   * descarta o job e o step fica `queued` até o reconciliador (minutos).
   * Manager fora de transação ativa → pool do pg-boss (comportamento antigo).
   */
  manager?: EntityManager;
}

/** Executor de SQL do pg-boss (`send(..., { db })`). */
export interface PgBossDb {
  executeSql(text: string, values: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
}

/**
 * Executor do pg-boss sobre a transação ATIVA do `manager` (mesmo query
 * runner, mesma conexão): o job nasce e morre com a transação. `null` quando
 * não há transação ativa — o chamador cai no pool do pg-boss.
 */
export function pgBossTransactionDb(manager: EntityManager | null | undefined): PgBossDb | null {
  const runner = manager?.queryRunner;
  if (!runner || runner.isReleased || !runner.isTransactionActive) return null;
  return {
    async executeSql(text: string, values: unknown[]) {
      const result: QueryResult = await runner.query(text, values, true);
      const rows = Array.isArray(result.records) ? result.records : [];
      return {
        rows,
        rowCount: typeof result.affected === 'number' ? result.affected : rows.length,
      };
    },
  };
}

/**
 * Porta estreita da fila (TDD ADR-01): permite troca de driver (BullMQ/Redis)
 * sem tocar consumers. Módulos novos (ex.: commercials) dependem desta
 * interface/serviço, nunca do pg-boss direto.
 */
export interface QueuePort {
  publish(
    queue: QueueName,
    data: Record<string, unknown>,
    options?: PublishOptions,
  ): Promise<string | null>;
  subscribe<T extends object>(
    queue: QueueName,
    concurrency: number,
    handler: (data: T, jobId: string) => Promise<void>,
    admit?: () => boolean,
  ): Promise<void>;
}

/**
 * Fila pg-boss sobre o Postgres existente (TDD ADR-01) — infraestrutura
 * compartilhada (plano-comerciais §11), extraída de modules/animations.
 */
@Injectable()
export class AnimationQueueService implements QueuePort, OnModuleInit, OnModuleDestroy {
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
    options: PublishOptions = {},
  ): Promise<string | null> {
    if (!this.boss) throw new Error('Fila não inicializada');
    const db = pgBossTransactionDb(options.manager);
    return this.boss.send(queue, data, {
      startAfter: options.startAfterSeconds,
      singletonKey: options.singletonKey,
      retryLimit: 3,
      retryBackoff: true,
      expireInSeconds: options.expireInSeconds ?? DEFAULT_EXPIRE_IN_SECONDS,
      ...(db ? { db: db as PgBoss.Db } : {}),
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
