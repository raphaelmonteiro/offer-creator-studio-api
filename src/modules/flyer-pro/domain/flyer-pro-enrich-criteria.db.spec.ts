import { DataSource } from 'typeorm';
import { describeIfE2eDb, openE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  insertClient,
  insertDocument,
  insertItems,
  purgeDocumentsOf,
} from '../testing/flyer-pro-documents.fixture';
import { BASE_ITEM, CRITERION_CASES } from './flyer-pro-enrich-criteria.cases.testutil';
import { criterionSql } from './flyer-pro-enrich-criteria';
import type { EnrichStep } from './flyer-pro-job.types';

const PHASES: EnrichStep[] = ['categorize', 'spellcheck', 'image_match'];

/**
 * A condição de consulta de cada critério contra o Postgres do banco de e2e, com a mesma tabela de casos do predicado:
 * os dois dizem o mesmo para cada caso. Um encarte por fase, só com os casos dela (o critério de uma fase não olha os
 * campos das outras).
 */
describeIfE2eDb('critérios das fases como condição de consulta (banco de e2e)', () => {
  jest.setTimeout(60_000);
  let dataSource: DataSource;
  let clientId: string;
  const documents = new Map<EnrichStep, { id: string; itemIds: string[] }>();

  beforeAll(async () => {
    dataSource = await openE2eDb();
    clientId = await insertClient(dataSource, 'Cliente critérios');
    for (const phase of PHASES) {
      const id = await insertDocument(dataSource, { clientId });
      const cases = CRITERION_CASES.filter((c) => c.phase === phase);
      const itemIds = await insertItems(
        dataSource,
        id,
        cases.map((c) => ({ ...BASE_ITEM, ...c.item })),
      );
      documents.set(phase, { id, itemIds });
    }
  });

  afterAll(async () => {
    await purgeDocumentsOf(dataSource, [clientId]);
    await dataSource.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
    await dataSource.destroy();
  });

  describe.each([
    ['onlyMissing ligado', 0, true],
    ['onlyMissing desligado', 1, false],
  ] as const)('%s', (_, column, onlyMissing) => {
    it.each(PHASES)('fase %s', async (phase) => {
      const { id, itemIds } = documents.get(phase) as { id: string; itemIds: string[] };
      const rows: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM flyer_pro_items WHERE "documentId" = $1 AND ${criterionSql(phase, onlyMissing)}`,
        [id],
      );

      const cases = CRITERION_CASES.filter((c) => c.phase === phase);
      const expected = cases.flatMap((c, index) => (c.eligible[column] ? [itemIds[index]] : []));
      expect(rows.map((row) => row.id).sort()).toEqual([...expected].sort());
      expect(cases.length).toBeGreaterThan(expected.length - 1);
    });
  });
});
