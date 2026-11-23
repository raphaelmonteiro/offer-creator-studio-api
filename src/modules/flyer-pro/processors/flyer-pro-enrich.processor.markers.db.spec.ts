import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  itemRowsOf,
  jobRowOf,
  makeEnrichWorld,
  mockPort,
  resultOf,
  useEnrichDb,
} from './flyer-pro-enrich.testutil';

const CERVEJA_EAN = '7896000000019';
const REFRIGERANTE_EAN = '7894900011524';

describeIfE2eDb('processador do job com o simulado: marcadores da fase de fotos (D-3 (a))', () => {
  const db = useEnrichDb();
  const { newDocument, start } = db;

  const photoJob = async (name: string, seeds: Array<{ name: string; ean?: string }>) => {
    const { documentId } = await newDocument(seeds.length, (index) => seeds[index], name);
    const world = makeEnrichWorld(db.dataSource, { port: mockPort() });
    const jobId = await start(world, documentId, { steps: ['image_match'] });
    const waits: Array<number | undefined> = [];
    while (world.messages.length > 0) {
      waits.push(world.messages[0].options.startAfterSeconds);
      await world.deliverOne();
    }
    return { documentId, job: await jobRowOf(db.dataSource, jobId), waits };
  };

  it('#ia-ean-pendente: os dois ficam ean_pending; na segunda passada o REFRIGERANTE recebe a foto, a CERVEJA segue pendente depois da terceira e o job termina done', async () => {
    const { documentId, job, waits } = await photoJob('Teste #ia-ean-pendente', [
      { name: 'CERVEJA PILSEN LATA 350ML', ean: CERVEJA_EAN },
      { name: 'REFRIGERANTE COLA 2L', ean: REFRIGERANTE_EAN },
    ]);

    const [cerveja, refrigerante] = await itemRowsOf(db.dataSource, documentId);
    expect(job.status).toBe('done');
    expect(waits.filter((wait) => wait !== undefined)).toEqual([30, 60, 120]);
    expect(cerveja).toMatchObject({ imageStatus: 'ean_pending' });
    expect(refrigerante).toMatchObject({
      imageStatus: 'applied',
      imageOrigin: 'match',
      imageWidth: 600,
      imageHeight: 1200,
    });
    expect(resultOf(job).image_match).toMatchObject({ visited: 2, applied: 1, eanPending: 1 });
    expect(resultOf(job).timing.image_ean_retry.batches).toBe(3);
  });

  it('sem marcador: nenhum item fica ean_pending e nenhuma passada roda', async () => {
    const { documentId, job, waits } = await photoJob('Ofertas Piccin semana 47', [
      { name: 'CERVEJA PILSEN LATA 350ML', ean: CERVEJA_EAN },
      { name: 'REFRIGERANTE COLA 2L', ean: REFRIGERANTE_EAN },
    ]);

    expect(job.status).toBe('done');
    expect(waits.filter((wait) => wait !== undefined)).toEqual([]);
    for (const item of await itemRowsOf(db.dataSource, documentId)) {
      expect(item.imageStatus).not.toBe('ean_pending');
    }
  });

  it('#IA-SEM-NOME: o ABACATE sem EAN continua none e o job traz nameSearchUnavailable', async () => {
    const { documentId, job } = await photoJob('Teste #IA-SEM-NOME', [{ name: 'ABACATE KG' }]);

    const [abacate] = await itemRowsOf(db.dataSource, documentId);
    expect(abacate).toMatchObject({ imageStatus: 'none', imageReview: null });
    expect(job.status).toBe('done');
    expect(resultOf(job).image_match).toMatchObject({ nameSearchUnavailable: true, notFound: 0 });
  });

  it('#ia-sem-credito: os dois itens com EAN ficam com eanStatus budget_blocked e o job conta 2', async () => {
    const { documentId, job } = await photoJob('Teste #ia-sem-credito', [
      { name: 'CERVEJA PILSEN LATA 350ML', ean: CERVEJA_EAN },
      { name: 'REFRIGERANTE COLA 2L', ean: REFRIGERANTE_EAN },
    ]);

    for (const item of await itemRowsOf(db.dataSource, documentId)) {
      expect(item.imageReview).toMatchObject({ eanStatus: 'budget_blocked' });
    }
    expect(resultOf(job).image_match).toMatchObject({ eanBudgetBlocked: 2 });
    expect(resultOf(job).image_match).not.toHaveProperty('nameSearchUnavailable');
  });
});
