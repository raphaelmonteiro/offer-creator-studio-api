import { insertItems } from '../testing/flyer-pro-documents.fixture';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  mockPort,
  useEnrichDb,
  wrapPort,
} from './flyer-pro-enrich.testutil';

describeIfE2eDb(
  'processador do job: o que ele escreve e a conferência final (banco de e2e, fila registrada)',
  () => {
    const db = useEnrichDb();
    const { newDocument, start } = db;

    describe('autoApply desligado: tudo vira sugestão', () => {
      it('a categoria fica pendente e a foto vira review com a foto como candidata, sem aplicar nada', async () => {
        const { documentId } = await newDocument(12, (i) => ({ name: `CERVEJA PILSEN ${i}` }));
        const world = makeEnrichWorld(db.dataSource);
        await start(world, documentId, { autoApply: false });

        await world.drain();

        for (const item of await itemRowsOf(db.dataSource, documentId)) {
          expect(item).toMatchObject({ category: null, categorySource: null });
          expect(item.categoryReview).toMatchObject({
            suggestion: { category: 'Bebidas', status: 'pending' },
          });
          expect(item.imageStatus).not.toBe('applied');
          expect(item.imageUrl).toBeNull();
        }
        const reviews = (await itemRowsOf(db.dataSource, documentId)).filter(
          (item) => item.imageStatus === 'review',
        );
        expect(reviews.length).toBeGreaterThan(0);
      });
    });

    it('categoria da planilha preservada: category e categorySource ficam, e a sugestão da tabela vai pendente', async () => {
      const { documentId } = await newDocument(1, () => ({
        name: 'SABÃO EM PÓ 1KG',
        category: 'Mercearia',
        categorySource: 'import',
      }));
      const world = makeEnrichWorld(db.dataSource);
      await start(world, documentId, { steps: ['categorize'] });

      await world.drain();

      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({ category: 'Mercearia', categorySource: 'import' });
      expect(item.categoryReview).toMatchObject({
        suggestion: { category: 'Limpeza', status: 'pending' },
      });
    });

    describe('conferência final', () => {
      it('importação durante o job: antes de terminar faz outra rodada e total cresce em 6 (3 fases x 2 itens)', async () => {
        const { documentId } = await newDocument(4);
        let inserted = false;
        const port = wrapPort(mockPort(), {
          matchImages: async () => {
            if (inserted) return;
            inserted = true;
            await insertItems(db.dataSource, documentId, [
              { name: 'NOVO 1', position: 100 },
              { name: 'NOVO 2', position: 101 },
            ]);
          },
        });
        const world = makeEnrichWorld(db.dataSource, { port });
        const jobId = await start(world, documentId);

        await world.drain();

        const job = await jobRowOf(db.dataSource, jobId);
        expect(job).toMatchObject({ status: 'done', total: 12 + 6, processed: 18 });
        expect(job.cursor).toMatchObject({ round: 2 });
        const novos = (await itemRowsOf(db.dataSource, documentId)).filter((item) =>
          String(item.name).startsWith('NOVO'),
        );
        for (const item of novos) {
          expect(item.categoryReview).not.toBeNull();
          expect(item.spellReview).not.toBeNull();
          expect(item.imageStatus).not.toBe('none');
        }
      });

      it('teto de rodadas: um item sem resposta em toda rodada faz 3 rodadas e o job termina done com o item ainda por fazer', async () => {
        const { documentId } = await newDocument(2);
        const silent = mockPort();
        const port = {
          ...wrapPort(silent, {}),
          matchImages: async (
            items: Parameters<typeof silent.matchImages>[0],
            context: Parameters<typeof silent.matchImages>[1],
          ) =>
            (await silent.matchImages(items, context)).filter(
              (verdict) => verdict.itemId !== items[0].id,
            ),
        };
        const world = makeEnrichWorld(db.dataSource, { port });
        const jobId = await start(world, documentId, { steps: ['image_match'] });

        await world.drain();

        const job = await jobRowOf(db.dataSource, jobId);
        expect(job.status).toBe('done');
        expect(job.cursor).toMatchObject({ round: 3 });
        const left = (await itemRowsOf(db.dataSource, documentId)).filter(
          (item) => item.imageStatus === 'none',
        );
        expect(left).toHaveLength(1);
      });

      it('item deixado como estava pelo provedor não é relido na mesma fase: o segundo lote começa depois do último do primeiro', async () => {
        const { documentId } = await newDocument(6);
        const seen: string[][] = [];
        const base = mockPort();
        const port = {
          ...wrapPort(base, {}),
          categorize: async (
            items: Parameters<typeof base.categorize>[0],
            context: Parameters<typeof base.categorize>[1],
          ) => {
            seen.push(items.map((item) => item.name));
            return (await base.categorize(items, context)).filter(
              (verdict) => verdict.itemId !== items[0].id,
            );
          },
        };
        const world = makeEnrichWorld(db.dataSource, { port, config: { categoryBatch: 3 } });
        await start(world, documentId, { steps: ['categorize'] });

        await world.drain();

        expect(seen[0]).toEqual(['PRODUTO 0', 'PRODUTO 1', 'PRODUTO 2']);
        expect(seen[1]).toEqual(['PRODUTO 3', 'PRODUTO 4', 'PRODUTO 5']);
      });
    });
  },
);
