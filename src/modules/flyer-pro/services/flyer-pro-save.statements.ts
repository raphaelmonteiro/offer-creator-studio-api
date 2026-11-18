import type { EntityManager } from 'typeorm';
import { flyerProNotFound } from '../domain/flyer-pro.errors';
import { FLYER_PRO_SLICE_KEYS } from '../domain/flyer-pro-slices';
import type { SaveFlyerProDocumentDto } from '../dto/save-flyer-pro-document.dto';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { DocumentColumns, documentUpdate } from './flyer-pro-document-update';

/** Os comandos do `PATCH` sobre a linha do encarte (N4): a trava, o carimbo, a regravação de conferência e a gravação. */

/** Só as chaves com valor: `undefined` não muda a coluna (`null` limpa onde ela aceita). */
function pickDefined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** Trava a linha viva do encarte até o fim da transação (`SELECT ... FOR UPDATE`); sem linha, 404. */
export async function lockDocument(manager: EntityManager, id: string): Promise<FlyerProDocument> {
  const document = await manager.findOne(FlyerProDocument, {
    where: { id },
    lock: { mode: 'pessimistic_write' },
  });
  if (!document) throw flyerProNotFound();
  return document;
}

/**
 * O relógio do banco, lido depois da trava, em UTC com microssegundos (o `Date` do JavaScript só tem ms): o carimbo
 * dos itens e do encarte, que cresce na ordem em que as gravações foram aceitas.
 */
export async function readStamp(manager: EntityManager): Promise<string> {
  const [{ stamp }] = await manager.query(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp`,
  );
  return stamp;
}

/** O resultado calculado que veio no corpo: digests e retrato da grade (`undefined` não vem). */
const resultOf = (dto: SaveFlyerProDocumentDto): DocumentColumns =>
  pickDefined({
    layoutDigest: dto.layoutDigest,
    renderDigest: dto.renderDigest,
    layoutSnapshot: dto.layoutSnapshot,
  });

/**
 * Regravação de conferência aplicada: só `engineVersion` e o que veio de resultado. Direto no SQL, sem `revision`,
 * `updatedAt`, `updatedByUserId`, `lastMutationId` nem `schemaVersion`. Sem nenhum dos três resultados, nada a gravar.
 */
export async function writeConference(
  manager: EntityManager,
  id: string,
  dto: SaveFlyerProDocumentDto,
): Promise<void> {
  const results = resultOf(dto);
  if (Object.keys(results).length === 0) return;
  const { sql, params } = documentUpdate(id, { ...results, engineVersion: dto.engineVersion });
  await manager.query(sql, params);
}

/** As fatias enviadas, cada uma inteira; as não enviadas ficam fora e a coluna não muda. */
const slicesOf = (dto: SaveFlyerProDocumentDto): DocumentColumns =>
  pickDefined(Object.fromEntries(FLYER_PRO_SLICE_KEYS.map((key) => [key, dto.slices?.[key]])));

/** Todas as colunas de um `PATCH` normal, sem o carimbo: revisão, mutação, versões, autor, resultado, fatias e Setup. */
export function saveColumns(
  document: FlyerProDocument,
  dto: SaveFlyerProDocumentDto,
  userId: string,
  setupColumns: DocumentColumns,
): DocumentColumns {
  return {
    ...setupColumns,
    ...slicesOf(dto),
    ...resultOf(dto),
    schemaVersion: dto.schemaVersion,
    engineVersion: dto.engineVersion,
    revision: document.revision + 1,
    lastMutationId: dto.mutationId,
    updatedByUserId: userId,
  };
}

/** Grava o `PATCH` normal com o carimbo em `updatedAt`; devolve o `updatedAt` gravado. */
export async function writeDocument(
  manager: EntityManager,
  id: string,
  columns: DocumentColumns,
  stamp: string,
): Promise<Date> {
  const { sql, params } = documentUpdate(id, { ...columns, updatedAt: stamp }, ['updatedAt']);
  const [rows] = await manager.query(sql, params);
  return rows[0].updatedAt;
}
