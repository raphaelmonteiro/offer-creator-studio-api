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

/** A recusa feita por pessoa durante o lote prevalece (PV-10): a sugestão lida entra no `WHERE` da escrita. */
describeIfE2eDb('processador do job: recusa durante o lote (banco de e2e)', () => {
  const db = useEnrichDb();
  const { newDocument, start } = db;

  const spelling = (checkedName: string, status: string) => ({
    checkedAt: '2026-11-17T10:00:00.000Z',
    jobId: '00000000-0000-4000-8000-000000000001',
    checkedName,
    suggestion: { value: 'FILÉ DE TILÁPIA CONGELADO', status },
  });
  const sheetCategory = (status: string) => ({
    categoryReview: {
      checkedAt: '2026-11-17T10:00:00.000Z',
      jobId: '00000000-0000-4000-8000-000000000001',
      suggestion: { category: 'Limpeza', confidence: 0.9, why: null, status },
    },
  });
  /** O gancho que muda o `status` da sugestão da coluna no meio da chamada ao provedor, como a pessoa faria. */
  const decide = (column: string, status: string, itemId: () => string, extra = '') => ({
    async categorize() {
      await decideRow(column, status, itemId(), extra);
    },
    async spellcheck() {
      await decideRow(column, status, itemId(), extra);
    },
  });
  const decideRow = (column: string, status: string, itemId: string, extra: string) =>
    db.dataSource.query(
      `UPDATE flyer_pro_items SET "${column}" = jsonb_set("${column}", '{suggestion}',
         ("${column}" -> 'suggestion') || jsonb_build_object('status', $2::text${extra})) WHERE id = $1`,
      [itemId, status],
    );

  describe('ortografia', () => {
    it('recusa do nome atual durante o lote (onlyMissing: false): o job não grava spellReview e a recusa fica', async () => {
      const { documentId, itemIds } = await newDocument(1, () => ({
        name: 'FILE DE TILAPIA CONJELADO',
        spellReview: spelling('FILE DE TILAPIA CONJELADO', 'pending') as never,
      }));
      const port = wrapPort(
        mockPort(),
        decide('spellReview', 'rejected', () => itemIds[0]),
      );
      const world = makeEnrichWorld(db.dataSource, { port });
      const jobId = await start(world, documentId, { steps: ['spellcheck'], onlyMissing: false });

      await world.drain();

      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({
        name: 'FILE DE TILAPIA CONJELADO',
        spellReview: spelling('FILE DE TILAPIA CONJELADO', 'rejected'),
      });
      expect(resultOf(await jobRowOf(db.dataSource, jobId)).spellcheck).toMatchObject({
        visited: 1,
        suggested: 0,
        clean: 0,
      });
    });

    it('recusa de outro nome não impede a gravação: o lote grava o spellReview do nome de agora', async () => {
      const { documentId } = await newDocument(1, () => ({
        name: 'FILE DE TILAPIA',
        spellReview: spelling('FILE DE TILAPIA CONJELADO', 'rejected') as never,
      }));
      const world = makeEnrichWorld(db.dataSource);
      await start(world, documentId, { steps: ['spellcheck'] });

      await world.drain();

      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item.spellReview).toMatchObject({ checkedName: 'FILE DE TILAPIA' });
    });
  });

  describe('categoria', () => {
    const sabao = () => ({
      name: 'SABAO EM PO 1KG',
      category: 'Mercearia',
      categorySource: 'import',
      categoryReview: sheetCategory('pending').categoryReview as never,
    });

    it('recusa durante o lote (onlyMissing: false): o job não grava categoria nem revisão e a recusa fica', async () => {
      const { documentId, itemIds } = await newDocument(1, sabao);
      const port = wrapPort(
        mockPort(),
        decide('categoryReview', 'rejected', () => itemIds[0]),
      );
      const world = makeEnrichWorld(db.dataSource, { port });
      await start(world, documentId, { steps: ['categorize'], onlyMissing: false });

      await world.drain();

      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({
        category: 'Mercearia',
        categorySource: 'import',
        categoryReview: sheetCategory('rejected').categoryReview,
      });
    });

    it('bloqueio durante o lote: o job não grava nada e a sugestão continua blocked com o motivo', async () => {
      const { documentId, itemIds } = await newDocument(1, sabao);
      const reason = ", 'reason', 'levaria o item para outra página'";
      const port = wrapPort(
        mockPort(),
        decide('categoryReview', 'blocked', () => itemIds[0], reason),
      );
      const world = makeEnrichWorld(db.dataSource, { port });
      await start(world, documentId, { steps: ['categorize'], onlyMissing: false });

      await world.drain();

      const [item] = await itemRowsOf(db.dataSource, documentId);
      expect(item).toMatchObject({ category: 'Mercearia', categorySource: 'import' });
      expect(item.categoryReview).toMatchObject({
        suggestion: { status: 'blocked', reason: 'levaria o item para outra página' },
      });
    });
  });
});
