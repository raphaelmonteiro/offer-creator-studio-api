import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  mockPort,
  resultOf,
  useEnrichDb,
  wrapPort,
} from './flyer-pro-enrich.testutil';
import { beat, claimBatch } from './flyer-pro-enrich.statements';

/** A ficha, a parada e a escrita condicionada ao estado lido, provadas contra o Postgres do banco de e2e. */
describeIfE2eDb('processador do job: ficha, parada e escrita condicionada (banco de e2e)', () => {
  const db = useEnrichDb();
  const { newDocument, start } = db;
  const sql = (text: string, params: unknown[] = []) => db.dataSource.query(text, params);
  /** O gancho que mexe no banco no meio da chamada ao provedor (e espera o comando terminar). */
  const run =
    (text: string, params: unknown[] | (() => unknown[]) = []) =>
    async () => {
      await sql(text, typeof params === 'function' ? params() : params);
    };

  /** A porta simulada contando as chamadas de cada fase. */
  function counted(hooks: Parameters<typeof wrapPort>[1] = {}) {
    const calls: string[] = [];
    const port = wrapPort(mockPort(), {
      categorize: () => void calls.push('categorize'),
      spellcheck: () => void calls.push('spellcheck'),
      matchImages: () => void calls.push('image_match'),
      ...hooks,
    });
    return { port, calls };
  }

  describe('lotes com ficha', () => {
    it('a mesma mensagem entregue duas vezes: a segunda não assume a ficha, não chama o provedor e não muda nada', async () => {
      const { documentId } = await newDocument(5);
      const { port, calls } = counted();
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['categorize'] });
      const message = world.messages[0].data;

      await world.processor.handle(message);
      const afterFirst = await jobRowOf(db.dataSource, jobId);
      await world.processor.handle(message);

      expect(calls).toEqual(['categorize']);
      expect(await jobRowOf(db.dataSource, jobId)).toEqual(afterFirst);
    });

    it('lote de job terminado: sai sem chamar o provedor, e o job continua done', async () => {
      const { documentId } = await newDocument(5);
      const { port, calls } = counted();
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['categorize'] });
      await world.drain();
      const done = await jobRowOf(db.dataSource, jobId);

      await world.processor.handle({ jobId, seq: done.batchSeq as number });

      expect(calls).toEqual(['categorize']);
      expect(await jobRowOf(db.dataSource, jobId)).toEqual(done);
    });

    it('lote zumbi: a ficha mudou durante a chamada, o resultado é descartado e nenhum item o recebe', async () => {
      const { documentId } = await newDocument(5);
      let jobId = '';
      const { port } = counted({
        categorize: run(
          `UPDATE flyer_pro_jobs SET "batchSeq" = "batchSeq" + 1 WHERE id = $1`,
          () => [jobId],
        ),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      jobId = await start(world, documentId, { steps: ['categorize'] });

      await world.deliverOne();

      for (const item of await itemRowsOf(db.dataSource, documentId)) {
        expect(item.categoryReview).toBeNull();
      }
      const job = await jobRowOf(db.dataSource, jobId);
      expect(job).toMatchObject({ status: 'running', processed: 0 });
      expect(world.messages).toEqual([]);
    });

    it('lote retomado: relê os mesmos itens que o lote morto ia gravar, a partir do ponto gravado pelo anterior', async () => {
      const { documentId } = await newDocument(6);
      const seen: string[][] = [];
      const base = mockPort();
      const port = wrapPort(base, {
        categorize: (items) => void seen.push(items.map((item) => item.name)),
      });
      const world = makeEnrichWorld(db.dataSource, { port, config: { categoryBatch: 2 } });
      const jobId = await start(world, documentId, { steps: ['categorize'] });
      await world.deliverOne();
      const afterFirst = await jobRowOf(db.dataSource, jobId);
      await claimBatch(db.dataSource, jobId, afterFirst.batchSeq as number); // o lote 2 assume e morre antes de gravar

      await world.processor.handle({ jobId, seq: (afterFirst.batchSeq as number) + 1 });

      expect(seen).toEqual([
        ['PRODUTO 0', 'PRODUTO 1'],
        ['PRODUTO 2', 'PRODUTO 3'],
      ]);
    });
  });

  describe('batimento', () => {
    it('batimento que saiu antes da gravação e chega depois dela: o heartbeatAt continua nulo', async () => {
      const { documentId } = await newDocument(5);
      const world = makeEnrichWorld(db.dataSource);
      const jobId = await start(world, documentId, { steps: ['image_match'] });
      const claimed = await claimBatch(db.dataSource, jobId, world.messages[0].data.seq);
      await world.committer.commitFailure(
        claimed as never,
        'image_match',
        { code: 'AI_PROVIDER_ERROR', terminal: false },
        null,
      );
      const afterCommit = await jobRowOf(db.dataSource, jobId);

      await beat(db.dataSource, jobId, claimed?.batchSeq as number);

      expect(afterCommit).toMatchObject({ status: 'running', heartbeatAt: null });
      expect(await jobRowOf(db.dataSource, jobId)).toEqual(afterCommit);
    });
  });

  describe('escrita condicionada ao estado lido', () => {
    it('categoria posta à mão durante o lote: o job não grava categoria nem revisão nesse item, e grava os outros', async () => {
      const { documentId, itemIds } = await newDocument(3, (i) => ({
        name: `COXA E SOBRECOXA ${i}`,
      }));
      const { port } = counted({
        categorize: run(
          `UPDATE flyer_pro_items SET category = 'Carnes', "categorySource" = 'user' WHERE id = $1`,
          [itemIds[0]],
        ),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['categorize'] });

      await world.drain();

      const [touched, ...others] = await itemRowsOf(db.dataSource, documentId);
      expect(touched).toMatchObject({
        category: 'Carnes',
        categorySource: 'user',
        categoryReview: null,
      });
      for (const item of others)
        expect(item).toMatchObject({ category: 'Carnes', categorySource: 'ai' });
      expect(resultOf(await jobRowOf(db.dataSource, jobId)).categorize).toMatchObject({
        visited: 3,
        applied: 2,
      });
    });

    it('nome mudado durante o lote de ortografia: o job não grava spellReview nesse item', async () => {
      const { documentId, itemIds } = await newDocument(2, (i) => ({
        name: `FILE DE TILAPIA CONJELADO ${i}`,
      }));
      const { port } = counted({
        spellcheck: run(`UPDATE flyer_pro_items SET name = 'OUTRO NOME' WHERE id = $1`, [
          itemIds[0],
        ]),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      await start(world, documentId, { steps: ['spellcheck'] });

      await world.deliverOne();

      const [renamed, kept] = await itemRowsOf(db.dataSource, documentId);
      expect(renamed).toMatchObject({ name: 'OUTRO NOME', spellReview: null });
      expect(kept.spellReview).not.toBeNull();
    });

    it('foto trocada no seletor durante o lote: o job não mexe na foto desse item, e os outros são gravados', async () => {
      const { documentId, itemIds } = await newDocument(4);
      const { port } = counted({
        matchImages: run(
          `UPDATE flyer_pro_items SET "imageStatus" = 'applied', "imageOrigin" = 'picker', "imageUrl" = 'http://x/escolhida.jpg' WHERE id = $1`,
          [itemIds[0]],
        ),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      await start(world, documentId, { steps: ['image_match'] });

      await world.drain();

      const [chosen, ...others] = await itemRowsOf(db.dataSource, documentId);
      expect(chosen).toMatchObject({
        imageOrigin: 'picker',
        imageUrl: 'http://x/escolhida.jpg',
        imageReview: null,
      });
      expect(others.every((item) => item.imageStatus !== 'none')).toBe(true);
    });

    it('categoria da IA trocada à mão ao refazer: o job não grava e a categoria fica como o operador pôs', async () => {
      const { documentId, itemIds } = await newDocument(1, () => ({
        name: 'CERVEJA PILSEN',
        category: 'Bebidas',
        categorySource: 'ai',
        categoryReview: { suggestion: { category: 'Bebidas', status: 'accepted', auto: true } },
      }));
      const { port } = counted({
        categorize: run(
          `UPDATE flyer_pro_items SET category = 'Mercearia', "categorySource" = 'user' WHERE id = $1`,
          [itemIds[0]],
        ),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      await start(world, documentId, { steps: ['categorize'], onlyMissing: false });

      await world.drain();

      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({ category: 'Mercearia', categorySource: 'user' });
      expect(item.categoryReview).toMatchObject({ suggestion: { status: 'accepted', auto: true } });
    });

    it('item apagado durante o lote: o lote grava os outros e o item não volta', async () => {
      const { documentId, itemIds } = await newDocument(3);
      const { port } = counted({
        matchImages: run(`DELETE FROM flyer_pro_items WHERE id = $1`, [itemIds[1]]),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      await start(world, documentId, { steps: ['image_match'] });

      await world.drain();

      const items = await itemRowsOf(db.dataSource, documentId);
      expect(items.map((item) => item.id)).toEqual([itemIds[0], itemIds[2]]);
      expect(items.every((item) => item.imageStatus !== 'none')).toBe(true);
    });
  });

  describe('parada', () => {
    it('pedido durante o lote: o lote grava o que conferiu, o job fecha canceled e nenhum lote novo é publicado', async () => {
      const { documentId } = await newDocument(40);
      let jobId = '';
      const { port } = counted({
        matchImages: run(
          `UPDATE flyer_pro_jobs SET "cancelRequestedAt" = now() WHERE id = $1`,
          () => [jobId],
        ),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.deliverOne();

      const job = await jobRowOf(db.dataSource, jobId);
      expect(job).toMatchObject({
        status: 'canceled',
        phase: 'image_match',
        processed: 16,
        heartbeatAt: null,
      });
      expect(job.finishedAt).toBeInstanceOf(Date);
      expect(world.messages).toEqual([]);
      const written = (await itemRowsOf(db.dataSource, documentId)).filter(
        (item) => item.imageStatus !== 'none',
      );
      expect(written).toHaveLength(16);
    });

    it('pedido antes de o lote assumir: fecha canceled sem chamar o provedor', async () => {
      const { documentId } = await newDocument(5);
      const { port, calls } = counted();
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId);
      await sql(`UPDATE flyer_pro_jobs SET "cancelRequestedAt" = now() WHERE id = $1`, [jobId]);

      await world.drain();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ status: 'canceled' });
      expect(calls).toEqual([]);
    });

    it('encarte excluído durante o lote: o lote grava, o job fecha canceled e nenhum lote novo sai', async () => {
      const { documentId } = await newDocument(40);
      const { port } = counted({
        matchImages: run(`UPDATE flyer_pro_documents SET "deletedAt" = now() WHERE id = $1`, [
          documentId,
        ]),
      });
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['image_match'] });

      await world.deliverOne();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({
        status: 'canceled',
        processed: 16,
      });
      expect(world.messages).toEqual([]);
    });

    it('encarte excluído antes de o lote assumir (job na fila): canceled sem chamar o provedor', async () => {
      const { documentId } = await newDocument(5);
      const { port, calls } = counted();
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId);
      await sql(`UPDATE flyer_pro_documents SET "deletedAt" = now() WHERE id = $1`, [documentId]);

      await world.drain();

      expect(await jobRowOf(db.dataSource, jobId)).toMatchObject({ status: 'canceled' });
      expect(calls).toEqual([]);
    });
  });
});
