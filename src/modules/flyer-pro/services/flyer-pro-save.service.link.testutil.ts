import type { PhotoChoice } from '../domain/flyer-pro-photo-choice';
import { PHOTO, PHOTO_GROUP } from '../testing/flyer-pro-photo-group.testutil';
import { itemRow } from './flyer-pro-documents.service.testutil';
import { ABACATE } from './flyer-pro-items.service.testutil';
import { makeSaveService, saveBody, storedDocument } from './flyer-pro-save.service.testutil';

/** Ajudantes dos unitários do registro da foto no salvar (só testes): o ABACATE com a foto da Galeria escolhida no seletor. */

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
