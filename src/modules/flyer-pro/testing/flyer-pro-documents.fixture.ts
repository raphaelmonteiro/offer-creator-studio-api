import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProItem } from '../entities/flyer-pro-item.entity';

/**
 * Encartes e itens gravados direto no banco, para os testes do módulo `flyer-pro` (só testes). Nenhuma rota da change 08
 * grava item, então o e2e da leitura, a change 09 (salvar) e o comando de teste da change 17 (U9.16) partem daqui:
 * `insertDocumentWithItems` é a peça "encarte com N itens" que eles chamam (D-1 (b)). Não muda a semente da 05.
 */

/** Cópia do template mínima para a linha existir (os testes de banco não leem as faces). */
const bareSnapshot = (sceneId: string) => ({ v: 1, sceneId, faces: [] });

export interface DocumentSeed extends Partial<Omit<FlyerProDocument, 'client'>> {
  clientId: string;
}

/** Grava um encarte; o que o teste não informa leva o padrão do 27×40, `step: 'products'` e `revision: 0`. */
export async function insertDocument(dataSource: DataSource, seed: DocumentSeed): Promise<string> {
  const sceneId = seed.sceneId ?? randomUUID();
  const { identifiers } = await dataSource.getRepository(FlyerProDocument).insert({
    name: 'Ofertas da semana',
    sceneId,
    format: '27x40',
    pageCount: 1,
    templateSnapshot: bareSnapshot(sceneId) as unknown as FlyerProDocument['templateSnapshot'],
    engineVersion: 1,
    ...seed,
  });
  return identifiers[0].id as string;
}

export interface ItemSeed extends Partial<Omit<FlyerProItem, 'document' | 'updatedAt'>> {
  /** O carimbo do item como texto do banco, com microssegundos (`2026-11-14 13:05:40.412377+00`). */
  updatedAtText?: string;
}

/** Os itens de um encarte, na ordem dada; sem `position`, a posição é a do índice. Devolve os ids na mesma ordem. */
export async function insertItems(
  dataSource: DataSource,
  documentId: string,
  items: ItemSeed[],
): Promise<string[]> {
  const repo = dataSource.getRepository(FlyerProItem);
  const ids: string[] = [];
  for (const [index, { updatedAtText, ...item }] of items.entries()) {
    const id = item.id ?? randomUUID();
    await repo.insert({
      name: `ITEM ${index}`,
      price: { kind: 'simple', cents: 699 },
      unit: 'cada',
      position: index,
      ...item,
      id,
      documentId,
    });
    if (updatedAtText) {
      await dataSource.query(`UPDATE flyer_pro_items SET "updatedAt" = $2 WHERE id = $1`, [
        id,
        updatedAtText,
      ]);
    }
    ids.push(id);
  }
  return ids;
}

/** O encarte com `count` itens (ou os itens dados): a peça que a 09 e o comando de teste da 17 chamam. */
export async function insertDocumentWithItems(
  dataSource: DataSource,
  seed: DocumentSeed,
  items: number | ItemSeed[],
): Promise<{ id: string; itemIds: string[] }> {
  const id = await insertDocument(dataSource, seed);
  const seeds = typeof items === 'number' ? Array.from({ length: items }, () => ({})) : items;
  return { id, itemIds: await insertItems(dataSource, id, seeds) };
}

/** Colunas do encarte que o teste muda para simular gravações (o que o `PATCH` da 09 gravaria). */
export async function updateDocumentRow(
  dataSource: DataSource,
  id: string,
  patch: Partial<Omit<FlyerProDocument, 'client' | 'updatedAt'>> & { updatedAt?: Date | string },
): Promise<void> {
  const columns = Object.keys(patch);
  const sets = columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ');
  const values = columns.map((column) => {
    const value = (patch as Record<string, unknown>)[column];
    return value !== null && typeof value === 'object' && !(value instanceof Date)
      ? JSON.stringify(value)
      : value;
  });
  await dataSource.query(`UPDATE flyer_pro_documents SET ${sets} WHERE id = $1`, [id, ...values]);
}

/** Apaga fisicamente os encartes dos clientes dados (itens em cascata): a FK `RESTRICT` barra a limpeza dos clientes. */
export async function purgeDocumentsOf(dataSource: DataSource, clientIds: string[]): Promise<void> {
  await dataSource.query(`DELETE FROM flyer_pro_documents WHERE "clientId" = ANY($1::uuid[])`, [
    clientIds,
  ]);
}
