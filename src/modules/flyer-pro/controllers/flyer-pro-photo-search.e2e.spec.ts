import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { overrideEnv } from '../../../shared/testing/e2e-app';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import type { PhotoDownloadResponseDto } from '../dto/flyer-pro-photo-download-response.dto';
import type { PhotoSearchResponseDto } from '../dto/flyer-pro-photo-search-response.dto';
import {
  DOCUMENTS_URL,
  envelope,
  newItemPayload,
  savePayload,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import type { FlyerProSaveView } from '../views/flyer-pro-save.view';

/**
 * e2e da busca de fotos do item no Google (change 47-add-flyer-pro-google-photo-search) sobre o harness da 05, com o provedor
 * simulado e as chaves pagas vazias do harness: o fluxo base (busca, download direto e por link do Google, `PATCH` com
 * `google` e o nome na foto), o guard JWT, um 400 e o 404 de `resultId` de outro item. A regra de cada campo, o teto, a
 * resposta guardada, as falhas da Serper e do download e o resto dos limites estão nos unitários (L-19).
 */
describeIfE2eDb('POST /v1/flyer-pro/documents/:id/items/:itemId/photo-search (e2e)', () => {
  // O padrão da variável é `real`: o app deste spec sobe com o simulado, e a chave da Serper fica vazia no harness.
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = overrideEnv({ FLYER_PRO_PHOTO_SEARCH_PROVIDER: 'mock' });
  });
  afterAll(() => restoreEnv());

  const { h, clientA, newDocument, open, patch } = useDocumentsE2e({ scenes: false });
  const searchUrl = (documentId: string, itemId: string) =>
    `${DOCUMENTS_URL}/${documentId}/items/${itemId}/photo-search`;
  const downloadUrl = (documentId: string, itemId: string) =>
    `${searchUrl(documentId, itemId)}/download`;
  const dataOf = <T>(response: { body: unknown }) => envelope<T>(response).data;

  /** As linhas de `gallery_images` que o spec criou (anotadas pelo id na hora): a limpeza apaga só estas (L-33). */
  const createdImageIds: string[] = [];
  h.onCleanup(async () => {
    if (createdImageIds.length === 0) return;
    await h.dataSource.query(`DELETE FROM gallery_images WHERE id = ANY($1::uuid[])`, [
      createdImageIds,
    ]);
  });

  const productFiles = () =>
    fs.readdir(path.join(h.uploadsDir, 'products')).catch(() => [] as string[]);
  const imageRows = async (imageId: string): Promise<number> =>
    (
      await h.dataSource.query(`SELECT count(*)::int AS n FROM gallery_images WHERE id = $1`, [
        imageId,
      ])
    )[0].n;

  async function documentWithContrafile() {
    const { id } = await newDocument();
    const item = newItemPayload({ name: 'CONTRAFILÉ BIFE KG', sourceName: 'CONTRA FILE BIFE KG' });
    await patch(id, savePayload(0, { items: { upsert: [item] } }));
    return { id, item };
  }

  async function download(documentId: string, itemId: string, resultId: string) {
    const response = await h.post(downloadUrl(documentId, itemId), { resultId });
    if (response.status === 200) {
      createdImageIds.push(dataOf<PhotoDownloadResponseDto>(response).imageId);
    }
    return response;
  }

  it('fluxo base: busca, download direto e por link do Google, e o PATCH com google grava o nome na foto', async () => {
    const { id, item } = await documentWithContrafile();

    const searched = await h.post(searchUrl(id, item.id), { term: 'CONTRAFILÉ BIFE KG' });

    expect(searched.status).toBe(200);
    const page = dataOf<PhotoSearchResponseDto>(searched);
    expect(page).toMatchObject({
      term: 'CONTRAFILÉ BIFE KG',
      page: 1,
      hasMore: true,
      fromCache: false,
    });
    expect(page.results).toHaveLength(10);
    expect(page.results[0]).not.toHaveProperty('imageUrl');

    const [direct, small, , goto] = page.results;
    const downloaded = await download(id, item.id, direct.resultId);
    const viaGoto = await download(id, item.id, goto.resultId);
    const tiny = await download(id, item.id, small.resultId);

    expect(downloaded.status).toBe(200);
    const photo = dataOf<PhotoDownloadResponseDto>(downloaded);
    expect(photo).toEqual({
      imageUrl: expect.stringMatching(/\/uploads\/products\/[0-9a-f-]+\.jpg$/),
      imageId: expect.any(String),
      width: 1000,
      height: 1000,
      small: false,
    });
    expect(dataOf<PhotoDownloadResponseDto>(viaGoto)).toMatchObject({ small: false });
    expect(dataOf<PhotoDownloadResponseDto>(tiny)).toMatchObject({ width: 240, small: true });
    expect(await productFiles()).toHaveLength(3);
    expect(await imageRows(photo.imageId)).toBe(1);

    const saved = await patch(
      id,
      savePayload(1, {
        items: {
          upsert: [
            {
              id: item.id,
              galleryImageId: photo.imageId,
              imageUrl: photo.imageUrl,
              imageWidth: photo.width,
              imageHeight: photo.height,
              imageOrigin: 'google',
            },
          ],
        },
      }),
    );

    expect(saved.status).toBe(200);
    expect(dataOf<FlyerProSaveView>(saved)).toMatchObject({
      revision: 2,
      applied: true,
      linkWarnings: [],
    });
    const [{ aliases }] = await h.dataSource.query(
      `SELECT metadata->'aliases' AS aliases FROM gallery_images WHERE id = $1`,
      [photo.imageId],
    );
    expect(aliases).toEqual([expect.objectContaining({ name: 'CONTRA FILE BIFE KG' })]);
    const preferred = await h.dataSource.query(
      `SELECT client_id FROM client_preferred_images WHERE image_id = $1`,
      [photo.imageId],
    );
    expect(preferred).toEqual([{ client_id: clientA() }]);
    expect((await open(id)).items[0]).toMatchObject({
      galleryImageId: photo.imageId,
      imageOrigin: 'google',
    });
  });

  it('sem token as duas rotas são 401, inclusive com :id que não é UUID (o guard vem antes do pipe)', async () => {
    const { id, item } = await documentWithContrafile();

    const search = await h
      .http()
      .post(`/v1${searchUrl(id, item.id)}`)
      .send({ term: 'ACÉM COM OSSO KG' });
    const downloading = await h
      .http()
      .post(`/v1${downloadUrl('abc', item.id)}`)
      .send({ resultId: 'r1' });

    expect([search.status, downloading.status]).toEqual([401, 401]);
    expect(envelope<unknown>(search).error?.code).toBe('UNAUTHORIZED');
    expect(envelope<unknown>(downloading).error?.code).toBe('UNAUTHORIZED');
  });

  it('URL no corpo do download é 400 BAD_REQUEST (pipe global com forbidNonWhitelisted), sem baixar nada', async () => {
    const { id, item } = await documentWithContrafile();
    const before = await productFiles();

    const response = await h.post(downloadUrl(id, item.id), {
      resultId: 'r1',
      imageUrl: 'https://exemplo.com/x.jpg',
    });

    expect(response.status).toBe(400);
    expect(envelope<unknown>(response).error?.code).toBe('BAD_REQUEST');
    expect(await productFiles()).toEqual(before);
  });

  it('o resultId de outro item é 404 FLYER_PRO_PHOTO_RESULT_NOT_FOUND, e nada é baixado nem registrado', async () => {
    const { id, item } = await documentWithContrafile();
    const searched = await h.post(searchUrl(id, item.id), { term: 'ACÉM COM OSSO KG' });
    const [first] = dataOf<PhotoSearchResponseDto>(searched).results;
    const before = await productFiles();

    const response = await h.post(downloadUrl(id, randomUUID()), { resultId: first.resultId });

    expect(response.status).toBe(404);
    expect(envelope<unknown>(response).error?.code).toBe('FLYER_PRO_PHOTO_RESULT_NOT_FOUND');
    expect(await productFiles()).toEqual(before);
  });
});
