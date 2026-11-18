import { QueryFailedError } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { readEnrichConfig } from '../config/flyer-pro-enrich.config';
import type { FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProJob } from '../entities/flyer-pro-job.entity';
import { FlyerProJobsService } from './flyer-pro-jobs.service';

/** Ajudantes dos unitários do serviço do job (só testes): o `manager` simulado, a fila e as linhas de job. */

export const CURSOR = '2026-11-14T13:05:40.412377Z';
export const DOC = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
export const ANA = 'b02d5a10-3c4e-4f7a-9d21-6e8f0a1b2c3d';

/** Uma linha de job como o banco a devolve; o que o teste não informa leva o estado de recém-criado (`queued`). */
export function jobRow(over: Partial<FlyerProJob> = {}): FlyerProJob {
  return {
    id: 'job-1',
    documentId: DOC,
    steps: ['image_match'],
    status: 'queued',
    phase: null,
    cursor: null,
    total: 78,
    processed: 0,
    itemIds: null,
    onlyMissing: true,
    autoApply: true,
    result: {},
    error: null,
    models: null,
    costUsd: null,
    batchSeq: 0,
    batchAttempts: 0,
    heartbeatAt: null,
    cancelRequestedAt: null,
    createdByUserId: ANA,
    createdAt: new Date('2026-11-14T13:06:00.000Z'),
    updatedAt: new Date('2026-11-14T13:06:00.000Z'),
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

export interface JobsWorld {
  /** O encarte existe e está vivo? */
  documentLive?: boolean;
  /** Quantos itens se encaixam no critério de cada fase (a conta do `total`). */
  counts?: { categorize?: number; spellcheck?: number; image_match?: number };
  /** Ids dos itens do encarte (o escopo de `itemIds`); o encarte tem item se houver algum. */
  itemIdsInDocument?: string[];
  active?: FlyerProJob | null;
  latest?: FlyerProJob | null;
  /** O job como o banco o devolve depois de um `UPDATE` do teste (o `manager` simulado não executa o SQL). */
  reloaded?: FlyerProJob;
}

/** O `23505` do índice de job ativo, como o driver o devolve. */
export const activeJobViolation = () =>
  new QueryFailedError('INSERT', [], {
    code: '23505',
    constraint: 'UQ_flyer_pro_jobs_document_active',
  } as unknown as Error);

/** O serviço sobre um `manager` que responde pelo SQL e registra o que foi inserido e publicado. */
export function makeJobsService(world: JobsWorld = {}, config?: Partial<FlyerProEnrichConfig>) {
  const state = { documentLive: true, itemIdsInDocument: [] as string[], ...world };
  const inserted: Array<Record<string, unknown>> = [];
  const manager = {
    findOne: jest.fn(async (entity: unknown, options: { where?: { status?: unknown } }) => {
      if (entity === FlyerProDocument) return state.documentLive ? { id: DOC } : null;
      return options.where?.status ? (state.active ?? null) : (state.latest ?? null);
    }),
    insert: jest.fn(async (_entity: unknown, values: Record<string, unknown>) => {
      inserted.push(values);
    }),
    findOneByOrFail: jest.fn(async (_entity: unknown, where: { id: string }) =>
      inserted.length === 0
        ? (state.reloaded ?? (state.active as FlyerProJob))
        : jobRow({
            ...(inserted[0] as Partial<FlyerProJob>),
            id: where.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
    ),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('to_char')) return [{ cursor: CURSOR }];
      if (sql.includes('SELECT 1 FROM flyer_pro_items')) {
        return state.itemIdsInDocument.length > 0 ? [{ '?column?': 1 }] : [];
      }
      if (sql.includes('SELECT id FROM flyer_pro_items')) {
        const wanted = params[1] as string[];
        return state.itemIdsInDocument.filter((id) => wanted.includes(id)).map((id) => ({ id }));
      }
      if (sql.includes('count(*)')) return [{ n: countFor(sql, world.counts ?? {}) }];
      return [];
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (...args: unknown[]) =>
      (args[args.length - 1] as (m: unknown) => unknown)(manager),
    ),
  };
  const queue = { publish: jest.fn().mockResolvedValue('queue-job-1') };
  const enrichConfig = readEnrichConfig(fakeConfig({}), { warn: jest.fn() });
  const service = new FlyerProJobsService(
    dataSource as unknown as DataSource,
    queue as never,
    { ...enrichConfig, ...config } as FlyerProEnrichConfig,
  );
  return {
    service,
    state,
    manager: manager as unknown as EntityManager & typeof manager,
    dataSource,
    queue,
    inserted,
  };
}

/** A conta de uma fase pelo SQL do critério (cada fase lê colunas próprias). */
function countFor(sql: string, counts: NonNullable<JobsWorld['counts']>): number {
  if (sql.includes('"categoryReview"')) return counts.categorize ?? 0;
  if (sql.includes('"spellReview"')) return counts.spellcheck ?? 0;
  return counts.image_match ?? 0;
}
