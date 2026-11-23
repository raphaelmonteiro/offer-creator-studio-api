import { randomUUID } from 'crypto';
import type { FlyerProSaveView } from '../views/flyer-pro-save.view';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  envelope,
  newItemPayload,
  savePayload,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';

/**
 * e2e do registro da escolha de foto na Galeria (change 27-add-flyer-pro-photo-picker, U2.7) sobre o harness da 05: o
 * `PATCH` com a foto da semente grava o nome em `metadata.aliases` e o par foto e cliente em
 * `client_preferred_images` pelo SQL real, e uma foto fora de `gallery_images` não desfaz a gravação. A regra de cada
 * origem, o nome, o EAN e a tradução da falha estão nos unitários do serviço de registro e do salvar (L-19).
 */
describeIfE2eDb('PATCH /v1/flyer-pro/documents/:id: registro da foto na Galeria (e2e)', () => {
  const { h, clientA, newDocument, open, patch } = useDocumentsE2e({ scenes: false });
  const data = (response: { body: unknown }) => envelope<FlyerProSaveView>(response).data;

  const photoOf = (image: { id: string; url: string }) => ({
    galleryImageId: image.id,
    imageUrl: image.url,
    imageWidth: 240,
    imageHeight: 240,
    imageOrigin: 'picker',
  });
  const aliasesOf = async (imageId: string) =>
    (
      await h.dataSource.query(
        `SELECT metadata->'aliases' AS aliases FROM gallery_images WHERE id = $1`,
        [imageId],
      )
    )[0].aliases;
  const preferredBy = async (imageId: string): Promise<string[]> =>
    (
      await h.dataSource.query(
        `SELECT client_id FROM client_preferred_images WHERE image_id = $1`,
        [imageId],
      )
    ).map((row: { client_id: string }) => row.client_id);

  async function documentWithAbacate() {
    const { id } = await newDocument();
    const abacate = newItemPayload({ sourceName: 'ABACATE' });
    await patch(id, savePayload(0, { items: { upsert: [abacate] } }));
    return { id, abacate };
  }

  it('o ABACATE com uma foto da semente e origem picker grava o nome na foto e a preferência do cliente', async () => {
    const [image] = h.seed.images;
    const { id, abacate } = await documentWithAbacate();

    const response = await patch(
      id,
      savePayload(1, { items: { upsert: [{ id: abacate.id, ...photoOf(image) }] } }),
    );

    expect(response.status).toBe(200);
    expect(data(response)).toMatchObject({ revision: 2, applied: true, linkWarnings: [] });
    expect(await aliasesOf(image.id)).toEqual([
      expect.objectContaining({ name: 'ABACATE', key: 'ABACATE' }),
    ]);
    expect(await preferredBy(image.id)).toEqual([clientA()]);
  });

  it('um galleryImageId fora de gallery_images responde 200 com GALLERY_IMAGE_NOT_FOUND, a revisão sobe e a foto fica no item', async () => {
    const { id, abacate } = await documentWithAbacate();
    const missing = { id: randomUUID(), url: 'http://localhost:3101/uploads/gallery/sumiu.png' };

    const response = await patch(
      id,
      savePayload(1, { items: { upsert: [{ id: abacate.id, ...photoOf(missing) }] } }),
    );

    expect(response.status).toBe(200);
    expect(data(response)).toMatchObject({
      revision: 2,
      linkWarnings: [{ itemId: abacate.id, code: 'GALLERY_IMAGE_NOT_FOUND' }],
    });
    const reopened = await open(id);
    expect(reopened.revision).toBe(2);
    expect(reopened.items[0]).toMatchObject({ id: abacate.id, galleryImageId: missing.id });
  });
});
