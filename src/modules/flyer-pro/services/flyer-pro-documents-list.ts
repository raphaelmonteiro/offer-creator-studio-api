import type { DataSource } from 'typeorm';
import { paginate, PaginationResult } from '../../../common/utils/pagination.util';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import {
  FlyerProDocumentListItemView,
  FlyerProDocumentListRow,
  toListItemView,
} from '../views/flyer-pro-document.view';
import { escapeLike } from './flyer-pro-scene.reader';

/** Filtros e página da lista de encartes (N2), já validados. */
export interface FlyerProDocumentsListInput {
  search?: string;
  clientId?: string;
  page?: number;
  limit?: number;
}

/** O `WHERE` da lista, com parâmetros posicionais: só os não excluídos, o cliente e o termo no nome (A-5). */
export function listWhere(query: FlyerProDocumentsListInput): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions = [`d."deletedAt" IS NULL`];
  if (query.clientId) {
    params.push(query.clientId);
    conditions.push(`d."clientId" = $${params.length}::uuid`);
  }
  if (query.search) {
    params.push(escapeLike(query.search));
    conditions.push(`unaccent(d.name) ILIKE '%' || unaccent($${params.length}::text) || '%'`);
  }
  return { where: conditions.join(' AND '), params };
}

const FROM = `FROM flyer_pro_documents d
  JOIN clients c ON c.id = d."clientId"
  LEFT JOIN users u ON u.id = d."updatedByUserId"`;

/**
 * N2: a página de encartes numa consulta só. `updatedAt` decrescente, com `id` decrescente para a página não trocar
 * de lugar entre duas chamadas. O total vem de `count(*) OVER ()`; página além do fim traz o total numa contagem à parte.
 */
export async function listDocuments(
  dataSource: DataSource,
  query: FlyerProDocumentsListInput,
): Promise<PaginationResult<FlyerProDocumentListItemView>> {
  const page = query.page ?? 1;
  const limit = query.limit ?? FLYER_PRO_LIMITS.listDefaultLimit;
  const { where, params } = listWhere(query);
  const rows: Array<FlyerProDocumentListRow & { total: number }> = await dataSource.query(
    `SELECT d.id, d.name, d."clientId", c.name AS "clientName", d.format, d."pageCount", d.step,
            (SELECT count(*)::int FROM flyer_pro_items i WHERE i."documentId" = d.id) AS "itemCount",
            d.revision, d."updatedByUserId", u.name AS "updatedByName", d."createdAt", d."updatedAt",
            (count(*) OVER ())::int AS total
       ${FROM}
      WHERE ${where}
      ORDER BY d."updatedAt" DESC, d.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit],
  );
  if (rows.length > 0) return paginate(rows.map(toListItemView), rows[0].total, { page, limit });
  const [{ total }] = await dataSource.query(
    `SELECT count(*)::int AS total ${FROM} WHERE ${where}`,
    params,
  );
  return paginate([], total, { page, limit });
}
