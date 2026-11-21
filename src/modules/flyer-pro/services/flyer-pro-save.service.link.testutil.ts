import type { PhotoChoice } from '../domain/flyer-pro-photo-choice';
import { itemRow } from './flyer-pro-documents.service.testutil';
import { makeSaveService, saveBody, storedDocument } from './flyer-pro-save.service.testutil';

/** Ajudantes dos unitários do registro da foto no salvar (só testes): o ABACATE com a foto da Galeria escolhida no seletor. */

export const ABACATE = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
export const PHOTO = '141da073-e2ab-4c8e-bb79-28e24074f743';
export const PHOTO_GROUP = {
  galleryImageId: PHOTO,
  imageUrl: 'http://localhost:3101/uploads/gallery/abacate.png',
  imageWidth: 640,
  imageHeight: 427,
  imageOrigin: 'picker',
};

/** Um `PATCH` com a foto do ABACATE no `items.upsert`; `over` troca ou acrescenta o que o caso pede. */
export const photoBody = (over: Record<string, unknown> = {}) =>
  saveBody({ items: { upsert: [{ id: ABACATE, ...PHOTO_GROUP }] }, ...over });

export const PHOTO_CHOICE: PhotoChoice = {
  itemId: ABACATE,
  galleryImageId: PHOTO,
  previousGalleryImageId: null,
  imageOrigin: 'picker',
};
export const SAVED_ABACATE = itemRow({ id: ABACATE, ...PHOTO_GROUP, imageStatus: 'applied' });

/**
 * Registra a ordem em que o salvar chama a transação e o registro da foto: `'commit'` quando a transação do
 * `fakeDataSource` termina e `'register'` quando o registro é chamado. Devolve o `order` que o teste lê (e que o
 * teste do job enche com `'job'`).
 */
export function recordSaveOrder(made: ReturnType<typeof makeSavingPhoto>): string[] {
  const order: string[] = [];
  const transaction = made.dataSource.transaction.getMockImplementation() as (
    ...args: unknown[]
  ) => Promise<unknown>;
  made.dataSource.transaction.mockImplementation(async (...args: unknown[]) => {
    const result = await transaction(...args);
    order.push('commit');
    return result;
  });
  made.links.register.mockImplementation(() => {
    order.push('register');
    return Promise.resolve([]);
  });
  return order;
}

/** O serviço com o ramo `items` devolvendo a foto do ABACATE gravada e a escolha lida contra o gravado antes. */
export function makeSavingPhoto(stored = storedDocument()) {
  const made = makeSaveService(stored);
  made.items.apply.mockResolvedValue({
    items: [SAVED_ABACATE],
    deletedItemIds: [],
    photoChoices: [PHOTO_CHOICE],
  });
  return made;
}
