import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  insertClient,
  insertDocument,
  insertItems,
  ItemSeed,
  purgeDocumentsOf,
} from '../testing/flyer-pro-documents.fixture';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { FlyerProEnrichConfig, readEnrichConfig } from '../config/flyer-pro-enrich.config';
import { MockFlyerProEnrich } from '../providers/flyer-pro-enrich.mock';
import type {
  EnrichCallContext,
  EnrichItemInput,
  FlyerProEnrichPort,
} from '../providers/flyer-pro-enrich.port';
import type { EnrichStep } from '../domain/flyer-pro-job.types';
import { FlyerProJobsService } from '../services/flyer-pro-jobs.service';
import { FlyerProEnrichCommitter } from './flyer-pro-enrich.committer';
import { FlyerProEnrichProcessor } from './flyer-pro-enrich.processor';
import type { BatchMessage } from './flyer-pro-enrich.types';

/**
 * Ajudantes dos testes de banco do processador (só testes): o processador e a criação do job sobre o banco de e2e, com a
 * fila trocada por um registro das mensagens. `drain` entrega as mensagens uma a uma, como o worker faria.
 */

export interface PublishedMessage {
  data: BatchMessage;
  options: { startAfterSeconds?: number; expireInSeconds?: number; retryLimit?: number };
}

/** O simulado com uma Galeria de `photos` fotos de 600×1200 (e `measure` configurável), sem esperar nos marcadores. */
export function mockPort(
  photoCount = 10,
  measure: () => Promise<{ width: number; height: number } | null> = async () => ({
    width: 600,
    height: 1200,
  }),
): MockFlyerProEnrich {
  const photos = Array.from({ length: photoCount }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    url: `http://localhost:3101/uploads/gallery/foto-${index}.jpg`,
    thumbnailUrl: null,
  }));
  return new MockFlyerProEnrich(
    { first: async (limit: number) => photos.slice(0, limit) },
    { measure },
    async () => undefined,
  );
}

export interface EnrichWorldOptions {
  port?: FlyerProEnrichPort;
  config?: Partial<FlyerProEnrichConfig>;
  /** Faz a publicação na fila falhar (a fila fora do ar). */
  publishFails?: boolean;
}

export function makeEnrichWorld(dataSource: DataSource, options: EnrichWorldOptions = {}) {
  const config: FlyerProEnrichConfig = {
    ...readEnrichConfig(fakeConfig({}), { warn: jest.fn() }),
    provider: 'mock',
    ...options.config,
  };
  const messages: PublishedMessage[] = [];
  const queue = {
    publish: jest.fn(
      async (_name: string, data: BatchMessage, opts: PublishedMessage['options']) => {
        if (options.publishFails) throw new Error('Fila não inicializada');
        messages.push({ data, options: opts });
        return 'queue-job';
      },
    ),
  };
  const committer = new FlyerProEnrichCommitter(dataSource, queue as never, config);
  const port = options.port ?? mockPort();
  const processor = new FlyerProEnrichProcessor(dataSource, committer, port, config);
  const jobs = new FlyerProJobsService(dataSource, queue as never, config);

  /** Entrega as mensagens na ordem em que foram publicadas, até a fila esvaziar; devolve quantas entregou. */
  async function drain(max = 200): Promise<number> {
    let delivered = 0;
    while (messages.length > 0 && delivered < max) {
      const message = messages.shift() as PublishedMessage;
      await processor.handle(message.data);
      delivered += 1;
    }
    return delivered;
  }

  /** Entrega só a próxima mensagem (um lote); `false` se a fila está vazia. */
  async function deliverOne(): Promise<boolean> {
    const message = messages.shift();
    if (!message) return false;
    await processor.handle(message.data);
    return true;
  }

  return { config, messages, queue, committer, processor, jobs, drain, deliverOne };
}

export type EnrichWorld = ReturnType<typeof makeEnrichWorld>;

/** Uma linha crua do banco. */
export type Row = Record<string, unknown>;

/** O `result` do job lido do banco: contagens por fase e o `timing`. */
export interface ResultOf {
  categorize: Record<string, number | string | null>;
  spellcheck: Record<string, number | string | null>;
  image_match: Record<string, number | string | null>;
  timing: Record<string, { batches: number; totalMs: number; maxMs: number }>;
}

export const resultOf = (job: Row): ResultOf => job.result as ResultOf;

/** O job como o banco o guarda, a linha crua. */
export async function jobRowOf(dataSource: DataSource, id: string): Promise<Row> {
  const [row] = await dataSource.query(`SELECT * FROM flyer_pro_jobs WHERE id = $1`, [id]);
  return row;
}

/** Os itens do encarte, na ordem, como o banco os guarda. */
export function itemRowsOf(dataSource: DataSource, documentId: string): Promise<Row[]> {
  return dataSource.query(
    `SELECT * FROM flyer_pro_items WHERE "documentId" = $1 ORDER BY position, id`,
    [documentId],
  );
}

type Hook = (items: EnrichItemInput[], context: EnrichCallContext) => Promise<void> | void;

/** A porta de `base` com ganchos que rodam antes de cada fase responder (para mexer no banco no meio do lote) e a disponibilidade trocável. */
export function wrapPort(
  base: FlyerProEnrichPort,
  hooks: {
    categorize?: Hook;
    spellcheck?: Hook;
    matchImages?: Hook;
    available?: (phase: EnrichStep) => boolean;
  },
): FlyerProEnrichPort {
  return {
    isAvailable: (phase) => hooks.available?.(phase) ?? base.isAvailable(phase),
    categorize: async (items, context) => {
      await hooks.categorize?.(items, context);
      return base.categorize(items, context);
    },
    spellcheck: async (items, context) => {
      await hooks.spellcheck?.(items, context);
      return base.spellcheck(items, context);
    },
    matchImages: async (items, context) => {
      await hooks.matchImages?.(items, context);
      return base.matchImages(items, context);
    },
  };
}

/**
 * O preparo comum dos specs de banco do processador: o banco de e2e, um cliente e a limpeza dos encartes no fim. Chame no
 * corpo do `describeIfE2eDb`. `newDocument` cria um encarte (revisão 12) com `count` itens, e `start` cria o job pelo serviço
 * (com o primeiro lote registrado na fila do mundo).
 */
export function useEnrichDb() {
  jest.setTimeout(120_000);
  const state = {} as { dataSource: DataSource; clientId: string };

  beforeAll(async () => {
    state.dataSource = await openE2eDb();
    state.clientId = await insertClient(state.dataSource, 'Cliente processador');
  });

  afterAll(async () => {
    await purgeDocumentsOf(state.dataSource, [state.clientId]);
    await state.dataSource.query(`DELETE FROM clients WHERE id = $1`, [state.clientId]);
    await state.dataSource.destroy();
  });

  async function newDocument(
    count: number,
    seed: (index: number) => ItemSeed = () => ({}),
    name = 'Ofertas Piccin semana 47',
  ) {
    const { dataSource, clientId } = state;
    const documentId = await insertDocument(dataSource, { clientId, name, revision: 12 });
    const itemIds = await insertItems(
      dataSource,
      documentId,
      Array.from({ length: count }, (_, index) => ({ name: `PRODUTO ${index}`, ...seed(index) })),
    );
    return { documentId, itemIds };
  }

  async function start(world: EnrichWorld, documentId: string, over: Record<string, unknown> = {}) {
    const job = await state.dataSource.transaction((manager) =>
      world.jobs.createJob(manager, {
        documentId,
        userId: randomUUID(),
        steps: ['categorize', 'spellcheck', 'image_match'],
        itemIds: null,
        onlyMissing: true,
        autoApply: true,
        ...over,
      }),
    );
    return job.id;
  }

  return {
    newDocument,
    start,
    /** O banco de e2e aberto (só depois do `beforeAll`). */
    get dataSource(): DataSource {
      return state.dataSource;
    },
  };
}

/** Itens com palavra da tabela de categorias, grafia errada e nome sem nada, em partes iguais (`ItemSeed` do índice). */
export const mixedItems = (index: number): ItemSeed => ({
  name: [
    `CERVEJA PILSEN ${index}`,
    `FILE DE TILAPIA CONJELADO ${index}`,
    `PRODUTO ${index}`,
    `PRODUTO ${index}`,
  ][index % 4],
});
