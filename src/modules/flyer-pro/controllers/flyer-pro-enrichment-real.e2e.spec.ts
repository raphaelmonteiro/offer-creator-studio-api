import { randomUUID } from 'crypto';
import { productAliasKey } from '../../gallery/product-alias';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  DocumentBody,
  envelope,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { insertItems } from '../testing/flyer-pro-documents.fixture';
import { enrichmentE2e } from '../testing/flyer-pro-enrichment.e2e.testutil';
import {
  removeGalleryPhotos,
  seedGalleryPhoto,
  SeededPhoto,
} from '../testing/flyer-pro-enrichment-real.e2e.testutil';
import type { FlyerProJobView } from '../views/flyer-pro-job.view';

type Job = FlyerProJobView;
const EAN_GALLERY = '7896000000019';
const EAN_OUTSIDE_GALLERY = '7894900011524';
const CERVEJA = 'CERVEJA PILSEN LATA 350ML';

/**
 * e2e do provedor real do job (change 29), com a fila real, o provedor `real` e as chaves vazias do harness
 * (`EAN_FLYER_RESOLVE_ENABLED=false`, embedding desligado): um job das três fases lido pelo N15 e os itens pelo N3. Só o
 * que depende do app montado, do SQL e do arquivo reais (L-19); o resto está nos unitários e nos specs de banco.
 */
describeIfE2eDb(
  'job de enriquecimento com o provedor real: fotos pelo EAN e pelo nome já escolhido (e2e)',
  () => {
    const { h, create, open } = useDocumentsE2e({
      scenes: false,
      jobQueue: true,
      enrichProvider: 'real',
    });
    jest.setTimeout(120_000);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { jobOf, startJob, until } = enrichmentE2e({ h, url: '/flyer-pro/documents', create });
    const photos: SeededPhoto[] = [];
    const state = {} as { id: string; job: Job; eanPhoto: SeededPhoto; namePhoto: SeededPhoto };

    beforeAll(async () => {
      const target = {
        dataSource: h.dataSource,
        uploadsDir: h.uploadsDir,
        cdnUrl: h.app.config.get<string>('CDN_URL') as string,
      };
      const suffix = randomUUID().slice(0, 8);
      state.eanPhoto = await seedGalleryPhoto(target, {
        filename: `e2e-real-ean-${suffix}.png`,
        width: 800,
        height: 640,
        metadata: { ean: EAN_GALLERY },
      });
      state.namePhoto = await seedGalleryPhoto(target, {
        filename: `e2e-real-nome-${suffix}.png`,
        width: 600,
        height: 1200,
        metadata: {
          aliases: [
            { name: CERVEJA, key: productAliasKey(CERVEJA), chosenAt: '2026-11-01T10:00:00Z' },
          ],
        },
      });
      photos.push(state.eanPhoto, state.namePhoto);
      h.onCleanup(() => removeGalleryPhotos(target, photos));

      const response = await create(h.seed.scenes.frontBack.id, {
        name: 'Ofertas Piccin semana 47',
      });
      state.id = envelope<DocumentBody>(response).data.id;
      await insertItems(h.dataSource, state.id, [
        { name: 'LEITE INTEGRAL 1L', ean: EAN_GALLERY, position: 0 },
        { name: CERVEJA, ean: EAN_OUTSIDE_GALLERY, position: 1 },
        { name: 'SALSINHA', position: 2 },
      ]);
      const started = await startJob(state.id, {
        steps: ['categorize', 'spellcheck', 'image_match'],
        itemIds: null,
        onlyMissing: true,
        autoApply: true,
      });
      expect(started.status).toBe(202);
      state.job = await until(state.id, ['done'], 100_000);
    }, 180_000);

    afterAll(() => {
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('sem chave: o job termina done, categorias e ortografia puladas, fotos rodadas, nenhum modelo mock e nenhum item com revisão de IA', async () => {
      const result = state.job.result as {
        categorize: { skipped: string | null; visited: number };
        spellcheck: { skipped: string | null; visited: number };
        image_match: { skipped: string | null };
      };
      expect(state.job).toMatchObject({ status: 'done', phase: null, error: null, costUsd: 0 });
      expect(result.categorize).toMatchObject({ skipped: 'AI_DISABLED', visited: 0 });
      expect(result.spellcheck).toMatchObject({ skipped: 'AI_DISABLED', visited: 0 });
      expect(result.image_match.skipped).toBeNull();
      expect(JSON.stringify(state.job.models)).not.toContain('mock');
      expect(await jobOf(state.id)).toMatchObject({ id: state.job.id, status: 'done' });
      for (const item of (await open(state.id)).items) {
        expect(item.categoryReview).toBeNull();
        expect(item.spellReview).toBeNull();
      }
    });

    it('o item com o EAN da Galeria fica applied com a medida do arquivo; a CERVEJA, applied pelo nome já escolhido com eanStatus budget_blocked; a SALSINHA continua none', async () => {
      const items = (await open(state.id)).items;
      const byName = (name: string) => items.find((item) => item.name === name);

      expect(byName('LEITE INTEGRAL 1L')).toMatchObject({
        imageStatus: 'applied',
        imageOrigin: 'match',
        imageWidth: 800,
        imageHeight: 640,
        imageReview: { eanStatus: 'gallery' },
      });
      expect(byName(CERVEJA)).toMatchObject({
        imageStatus: 'applied',
        imageWidth: 600,
        imageHeight: 1200,
        imageReview: { eanStatus: 'budget_blocked' },
      });
      expect(byName('SALSINHA')).toMatchObject({ imageStatus: 'none', imageReview: null });
      expect(state.job.result).toMatchObject({
        image_match: { nameSearchUnavailable: true, eanBudgetBlocked: 1 },
      });
    });
  },
);
