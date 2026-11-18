import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { deriveItem } from '../domain/flyer-pro-item-derive';
import { draftOf } from '../domain/flyer-pro-item-merge';
import { validateItems } from '../domain/flyer-pro-item-rules';
import { ItemDraft } from '../domain/flyer-pro-item.types';
import {
  flyerProItemIdConflict,
  flyerProItemInvalid,
  flyerProItemLimit,
} from '../domain/flyer-pro.errors';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import type { FlyerProItemsPatchDto } from '../dto/flyer-pro-items-patch.dto';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import {
  countItems,
  deleteItems,
  deleteItemsExcept,
  findItems,
  insertItems,
  ItemRow,
  updateItems,
} from './flyer-pro-item.statements';

/** O carimbo da gravação (lido depois da trava do encarte) e o usuário do token. */
export interface ItemsContext {
  stamp: string;
  userId: string;
}

/** O que o ramo `items` devolve ao `PATCH`: os itens de `upsert` como ficaram, na ordem dele, e os ids apagados. */
export interface ItemsOutcome {
  items: FlyerProItem[];
  deletedItemIds: string[];
}

/**
 * O ramo `items` do `PATCH` (N4), dentro da transação do salvar, na ordem do contrato: apagar `delete`; ler os itens
 * citados em `upsert` (id de outro encarte é 409); mesclar; validar todos (422, com todos os `issues`); derivar o que só o
 * servidor escreve; gravar em lote com o carimbo; `replaceAll` apaga o resto; contar (422 acima de 500). Uma recusa em
 * qualquer passo desfaz a transação inteira.
 */
@Injectable()
export class FlyerProItemsService {
  async apply(
    manager: EntityManager,
    documentId: string,
    patch: FlyerProItemsPatchDto,
    context: ItemsContext,
  ): Promise<ItemsOutcome> {
    const deletedItemIds = await deleteItems(manager, documentId, patch.delete ?? []);
    const upsert = patch.upsert ?? [];
    const ids = upsert.map((entry) => entry.id);
    const drafts = await this.draftsOf(manager, documentId, patch);
    const issues = validateItems(drafts);
    if (issues.length > 0) throw flyerProItemInvalid(issues);
    const rows = splitRows(documentId, drafts, context);
    await this.write(manager, documentId, rows, context.stamp);
    if (patch.replaceAll) {
      deletedItemIds.push(...(await deleteItemsExcept(manager, documentId, ids)));
    }
    await this.assertWithinLimit(manager, documentId);
    return { items: await findItems(manager, ids, documentId), deletedItemIds };
  }

  /** O estado atual dos itens citados em `upsert` que existem no encarte, na ordem de `upsert` (o reenvio os devolve). */
  currentOf(
    manager: EntityManager,
    documentId: string,
    upsert: Array<{ id: string }> = [],
  ): Promise<FlyerProItem[]> {
    return findItems(
      manager,
      upsert.map((entry) => entry.id),
      documentId,
    );
  }

  /** Lê os itens citados (de qualquer encarte), recusa os de outro encarte e mescla cada entrada sobre o seu item. */
  private async draftsOf(
    manager: EntityManager,
    documentId: string,
    patch: FlyerProItemsPatchDto,
  ): Promise<ItemDraft[]> {
    const upsert = patch.upsert ?? [];
    const cited = await findItems(
      manager,
      upsert.map((entry) => entry.id),
    );
    const foreign = cited.filter((item) => item.documentId !== documentId);
    if (foreign.length > 0) throw flyerProItemIdConflict(foreign.map((item) => item.id));
    const byId = new Map(cited.map((item) => [item.id, item]));
    return upsert.map((entry) => draftOf(entry, byId.get(entry.id) ?? null, !!patch.replaceAll));
  }

  /** Os novos entram numa inserção só e os existentes numa atualização só; todos com o mesmo carimbo. */
  private async write(
    manager: EntityManager,
    documentId: string,
    rows: { fresh: ItemRow[]; known: ItemRow[] },
    stamp: string,
  ): Promise<void> {
    await insertItems(manager, rows.fresh, stamp);
    await updateItems(manager, documentId, rows.known, stamp);
  }

  private async assertWithinLimit(manager: EntityManager, documentId: string): Promise<void> {
    const total = await countItems(manager, documentId);
    if (total > FLYER_PRO_LIMITS.itemMax) {
      throw flyerProItemLimit({ max: FLYER_PRO_LIMITS.itemMax, total });
    }
  }
}

/** As linhas prontas para gravar, separadas em itens novos e itens que já existem no encarte. */
function splitRows(documentId: string, drafts: ItemDraft[], context: ItemsContext) {
  const rows = { fresh: [] as ItemRow[], known: [] as ItemRow[] };
  for (const draft of drafts) {
    const derived = deriveItem(draft, { stamp: context.stamp, userId: context.userId });
    const row: ItemRow = { ...draft.merged, ...derived, id: draft.entry.id, documentId };
    (draft.stored ? rows.known : rows.fresh).push(row);
  }
  return rows;
}
