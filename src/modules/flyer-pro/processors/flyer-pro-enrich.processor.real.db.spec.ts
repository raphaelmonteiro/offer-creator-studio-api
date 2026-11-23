// A busca de fotos do provedor real puxa o importador de fotos da DotCompany → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { openAiError } from '../../ai/utils/openai-chat.testutil';
import { chatResponse } from '../../ai/utils/openai-chat.testutil';
import type { ItemSeed } from '../testing/flyer-pro-documents.fixture';
import {
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  resultOf,
  useEnrichDb,
} from './flyer-pro-enrich.testutil';
import { realPort } from './flyer-pro-enrich.real.testutil';

/** 78 itens: 9 sem categoria, 4 da planilha que a IA contesta e 65 da planilha em que ela concorda. */
const piccin = (index: number): ItemSeed => {
  if (index < 9) return { name: `PRODUTO ${index}` };
  const sheet = index < 13 ? 'Mercearia' : 'Hortifruti';
  return { name: `PRODUTO ${index}`, category: sheet, categorySource: 'import' };
};
const piccinAnswers = Object.fromEntries(
  Array.from({ length: 78 }, (_, index) => [
    `PRODUTO ${index}`,
    index < 9
      ? { category: 'Carnes', confidence: 0.9 }
      : { category: index < 13 ? 'Limpeza' : 'Hortifruti', confidence: 0.9 },
  ]),
);
const piccinFixes = Object.fromEntries(
  [0, 1, 2, 3, 4].map((index) => [`PRODUTO ${index}`, `PRODUTO CORRIGIDO ${index}`]),
);

describeIfE2eDb(
  'processador do job com o provedor real (serviços de IA simulados, banco de e2e)',
  () => {
    const db = useEnrichDb();
    const { newDocument, start } = db;

    describe('job de 78 itens', () => {
      it('cada lote chama o serviço dele uma vez, nada vem do simulado e as contagens são as da planilha e das correções', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch');
        const { documentId } = await newDocument(78, piccin);
        const real = realPort({ categories: piccinAnswers, fixes: piccinFixes });
        const categorize = jest.spyOn(real.categorization, 'categorizeProducts');
        const spellCheck = jest.spyOn(real.spell, 'spellCheck');
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId);

        await world.drain();

        const job = await jobRowOf(db.dataSource, jobId);
        expect(job).toMatchObject({ status: 'done', total: 234, processed: 234 });
        expect(categorize).toHaveBeenCalledTimes(2);
        expect(spellCheck).toHaveBeenCalledTimes(2);
        expect(real.findImages).toHaveBeenCalledTimes(5);
        expect(resultOf(job).categorize).toEqual({
          visited: 78,
          applied: 9,
          suggested: 4,
          unchanged: 65,
          skipped: null,
        });
        expect(resultOf(job).spellcheck).toEqual({
          visited: 78,
          suggested: 5,
          clean: 73,
          skipped: null,
        });
        expect(resultOf(job).image_match).toMatchObject({
          visited: 78,
          notFound: 78,
          skipped: null,
        });
        expect(JSON.stringify(await itemRowsOf(db.dataSource, documentId))).not.toContain(
          '[simulado]',
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      it('o item da planilha fica, a categoria sugerida vai pendente, e o do operador nunca é tocado', async () => {
        const { documentId } = await newDocument(78, piccin);
        const real = realPort({ categories: piccinAnswers });
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        await start(world, documentId, { steps: ['categorize'] });

        await world.drain();

        const items = await itemRowsOf(db.dataSource, documentId);
        expect(items[0]).toMatchObject({ category: 'Carnes', categorySource: 'ai' });
        expect(items[10]).toMatchObject({ category: 'Mercearia', categorySource: 'import' });
        expect(items[10].categoryReview).toMatchObject({
          suggestion: { category: 'Limpeza', status: 'pending' },
        });
        expect(items[20].categoryReview).toMatchObject({ suggestion: null });
      });
    });

    describe('o provedor real sem chave e com as fases desligadas', () => {
      it('sem chave: categorias e ortografia puladas, fotos rodam sem a busca por nome, nenhum modelo "mock" e nenhuma requisição externa', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch');
        const { documentId } = await newDocument(5);
        const real = realPort({ env: { OPENAI_API_KEY: '' }, nameSearch: false });
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId);

        await world.drain();

        const job = await jobRowOf(db.dataSource, jobId);
        // sem a busca por nome os 5 itens ficam `none` e voltam à fase de fotos nas duas rodadas seguintes (D-5 (a))
        expect(job).toMatchObject({ status: 'done', total: 25, processed: 25 });
        expect(job.cursor).toMatchObject({ round: 3 });
        expect(resultOf(job).categorize).toMatchObject({ skipped: 'AI_DISABLED', visited: 0 });
        expect(resultOf(job).spellcheck).toMatchObject({ skipped: 'AI_DISABLED', visited: 0 });
        expect(resultOf(job).image_match).toMatchObject({
          skipped: null,
          visited: 15,
          notFound: 0,
          nameSearchUnavailable: true,
        });
        expect(Object.keys(job.models as object)).toEqual(['image_match']);
        expect(JSON.stringify(job.models)).not.toContain('mock');
        expect(real.categorizeCreate).not.toHaveBeenCalled();
        expect(real.spellCreate).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      it.each([
        ['categorize', { AI_PRODUCT_CATEGORIZATION_ENABLED: 'false' }, 'categoryReview'],
        ['spellcheck', { AI_SPELLCHECK_ENABLED: 'false' }, 'spellReview'],
      ])(
        '%s desligada pela flag com a chave presente: pulada, sem revisão nos itens, e as outras fases rodam',
        async (phase, env, column) => {
          const { documentId } = await newDocument(4);
          const real = realPort({ env });
          const world = makeEnrichWorld(db.dataSource, { port: real.port });
          const jobId = await start(world, documentId);

          await world.drain();

          const result = resultOf(await jobRowOf(db.dataSource, jobId)) as unknown as Record<
            string,
            Record<string, unknown>
          >;
          expect(result[phase]).toMatchObject({ skipped: 'AI_DISABLED' });
          for (const item of await itemRowsOf(db.dataSource, documentId))
            expect(item[column]).toBeNull();
          expect(Object.keys(result).filter((key) => key !== 'timing')).toHaveLength(3);
        },
      );

      it('o marcador do simulado no nome do encarte não muda nada com o provedor real', async () => {
        const { documentId } = await newDocument(4, () => ({}), 'Teste #ia-ean-pendente #ia-falha');
        const real = realPort();
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId, { steps: ['image_match'] });

        await world.drain();

        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ status: 'done' });
        for (const item of await itemRowsOf(db.dataSource, documentId)) {
          expect(item).toMatchObject({ imageStatus: 'not_found' });
        }
      });
    });

    describe('falhas dos serviços', () => {
      it('todas as respostas sem categoria segura (fallback): a fase não é pulada e a conferência final repete até 3 rodadas', async () => {
        const { documentId } = await newDocument(3);
        const real = realPort({
          categories: { 'PRODUTO 0': { category: 'Inventada', confidence: 0.9 } },
        });
        real.categorizeCreate.mockImplementation(
          async (body: { messages: Array<{ content: string }> }) => {
            const sent = JSON.parse(body.messages[1].content) as {
              products: Array<{ id: string }>;
            };
            const assignments = sent.products.map((p) => ({
              productId: p.id,
              category: 'Inventada',
              confidence: 0.9,
              source: 'ai',
              reason: 'x',
            }));
            return chatResponse({ content: JSON.stringify({ assignments }) });
          },
        );
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId, { steps: ['categorize'] });

        await world.drain();

        const job = await jobRowOf(db.dataSource, jobId);
        expect(job).toMatchObject({ status: 'done', total: 9, processed: 9 });
        expect(resultOf(job).categorize).toMatchObject({
          visited: 9,
          applied: 0,
          suggested: 0,
          skipped: null,
        });
        expect(job.cursor).toMatchObject({ round: 3 });
        for (const item of await itemRowsOf(db.dataSource, documentId))
          expect(item.categoryReview).toBeNull();
      });

      it('queda passageira (503) na categorização: o lote não grava nada, é repetido depois de 15 s e, na repetição, grava', async () => {
        const { documentId } = await newDocument(3);
        const real = realPort();
        real.categorizeCreate.mockRejectedValueOnce(openAiError(503, 'indisponível'));
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId, { steps: ['categorize'] });

        await world.deliverOne();

        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
          status: 'running',
          batchAttempts: 1,
        });
        expect(world.messages[0].options).toMatchObject({ startAfterSeconds: 15 });
        for (const item of await itemRowsOf(db.dataSource, documentId))
          expect(item.categoryReview).toBeNull();
        await world.drain();
        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ status: 'done' });
        for (const item of await itemRowsOf(db.dataSource, documentId))
          expect(item.categoryReview).not.toBeNull();
      });

      it('chave inválida (401) na ortografia: failed na hora, sem repetir, e as categorias já gravadas ficam', async () => {
        const { documentId } = await newDocument(3);
        const real = realPort({
          spellCall: () => {
            throw openAiError(401, 'chave inválida');
          },
        });
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId, { steps: ['categorize', 'spellcheck'] });

        await world.drain();

        const job = await jobRowOf(db.dataSource, jobId);
        expect(job).toMatchObject({
          status: 'failed',
          error: { code: 'AI_PROVIDER_ERROR', phase: 'spellcheck' },
        });
        expect(real.spellCreate).toHaveBeenCalledTimes(1);
        for (const item of await itemRowsOf(db.dataSource, documentId)) {
          expect(item.categoryReview).not.toBeNull();
          expect(item.spellReview).toBeNull();
        }
      });

      it('resposta fora do formato em todas as tentativas: três lotes, failed com AI_PROVIDER_ERROR e itens sem revisão', async () => {
        const { documentId } = await newDocument(3);
        const real = realPort();
        real.categorizeCreate.mockResolvedValue(
          chatResponse({ content: '{"assignments":"não é lista"}' }),
        );
        const world = makeEnrichWorld(db.dataSource, { port: real.port });
        const jobId = await start(world, documentId, { steps: ['categorize'] });

        await world.drain();

        expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
          status: 'failed',
          error: { code: 'AI_PROVIDER_ERROR', phase: 'categorize' },
        });
        for (const item of await itemRowsOf(db.dataSource, documentId))
          expect(item.categoryReview).toBeNull();
      });
    });
  },
);
