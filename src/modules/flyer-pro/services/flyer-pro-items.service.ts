import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { deriveItem } from '../domain/flyer-pro-item-derive';
import { draftOf } from '../domain/flyer-pro-item-merge';
import { importIdsOfNewItems, validateItems } from '../domain/flyer-pro-item-rules';
import { utcInstantOf } from '../domain/flyer-pro-instant';
import { ItemDraft } from '../domain/flyer-pro-item.types';
import {
  flyerProItemIdConflict,
  flyerProItemInvalid,
  flyerProItemLimit,
  flyerProNotFound,
} from '../domain/flyer-pro.errors';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import type { FlyerProItemsPatchDto } from '../dto/flyer-pro-items-patch.dto';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import { FlyerProItemView, toItemView } from '../views/flyer-pro-document.view';
import { findKnownImportIds } from './flyer-pro-import.statements';
import {
  countItems,
  deleteItems,
  deleteItemsExcept,
  findItems,
  insertItems,
  ItemRow,
  updateItems,
} from './flyer-pro-item.statements';
import { readWith } from './flyer-pro-read';

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

/** A leitura incremental (N12): `{ items, cursor }`. */
export interface FlyerProItemsPage {
  items: FlyerProItemView[];
  cursor: string;
}

const AFTER = `($2::timestamptz IS NULL OR "updatedAt" > $2::timestamptz)`;

const ITEMS_AFTER_SQL = `SELECT * FROM "flyer_pro_items"
  WHERE "documentId" = $1 AND ${AFTER} ORDER BY "position" ASC, "id" ASC`;

/**
 * O maior `updatedAt` devolvido (UTC, microssegundos). Sem itens: o `updatedAfter` no mesmo formato ou, sem ele, o
 * `createdAt` do encarte.
 */
const ITEMS_CURSOR_SQL = `SELECT to_char(
    COALESCE(
      (SELECT max("updatedAt") FROM "flyer_pro_items" WHERE "documentId" = $1 AND ${AFTER}),
      $2::timestamptz,
      (SELECT "createdAt" FROM "flyer_pro_documents" WHERE "id" = $1)
    ) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor`;

/**
 * O ramo `items` do `PATCH` (N4), dentro da transação do salvar, na ordem do contrato: apagar `delete`; ler os itens
 * citados em `upsert` (id de outro encarte é 409); ler as importações do encarte a que os itens novos se ligam (a do
 * corpo, gravada antes, entra pela mesma transação); mesclar; validar todos (422, com todos os `issues`); derivar o que só o
 * servidor escreve; gravar em lote com o carimbo; `replaceAll` apaga o resto; contar (422 acima de 500). Uma recusa em
 * qualquer passo desfaz a transação inteira.
 */
@Injectable()
export class FlyerProItemsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * N12: os itens do encarte vivo, todos ou só os gravados depois de `updatedAfter` (comparado com microssegundos), em
   * ordem de `position` e `id`, e o cursor em texto calculado no banco. Não grava nada; itens e cursor saem do mesmo
   * instante do banco.
   */
  list(id: string, updatedAfter?: string): Promise<FlyerProItemsPage> {
    const after = updatedAfter ? utcInstantOf(updatedAfter) : null;
    return readWith(this.dataSource, undefined, async (manager) => {
      const document = await manager.findOne(FlyerProDocument, {
        where: { id },
        select: { id: true },
      });
      if (!document) throw flyerProNotFound();
      const items: FlyerProItem[] = await manager.query(ITEMS_AFTER_SQL, [id, after]);
      const [{ cursor }] = await manager.query(ITEMS_CURSOR_SQL, [id, after]);
      return { items: items.map(toItemView), cursor };
    });
  }

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
    const imports = await findKnownImportIds(manager, documentId, importIdsOfNewItems(drafts));
    const issues = validateItems(drafts, imports);
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
    // `importId` só entra na inserção: o `UPDATE` não o escreve (A-8).
    if (draft.stored) rows.known.push(row);
    else rows.fresh.push({ ...row, importId: draft.entry.importId ?? null });
  }
  return rows;
}
