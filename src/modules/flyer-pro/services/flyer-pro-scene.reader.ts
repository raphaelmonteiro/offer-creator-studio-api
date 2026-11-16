import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { FaceRow, SceneRow, TemplateRow } from '../domain/flyer-pro-template-rows';

export interface ScenePageFilters {
  /** Ids de cena (`folheto-27x40`...) que a página aceita. */
  formatIds: readonly string[];
  search?: string;
  sceneId?: string;
  page: number;
  limit: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCENE_COLUMNS = `s.id, s.name, s."formatId", s.layout, s."artHeightCm", s.revision, s."updatedAt",
  s."approvedTemplateId", s."deletedAt"`;

/** Face pronta (A-11): o template apontado existe e traz o marcador de cena; na face 0 sem `templateId`, o da cena. */
const HAS_READY_FACE = `EXISTS (
  SELECT 1 FROM template_scene_faces f
  JOIN templates t ON t.id = COALESCE(f."templateId", CASE WHEN f."index" = 0 THEN s."approvedTemplateId" END)
  WHERE f."sceneId" = s.id AND t.configuration #>> '{source,kind}' = 'template-scene'
)`;

/** `%`, `_` e `\` do termo valem como texto no `ILIKE`. */
export const escapeLike = (term: string): string => term.replace(/[\\%_]/g, '\\$&');

interface RawScene extends Omit<SceneRow, 'artHeightCm'> {
  artHeightCm: string | number;
}

const toSceneRow = (raw: RawScene): SceneRow => ({
  id: raw.id,
  name: raw.name,
  formatId: raw.formatId,
  layout: raw.layout,
  artHeightCm: Number(raw.artHeightCm),
  revision: raw.revision,
  updatedAt: raw.updatedAt,
  approvedTemplateId: raw.approvedTemplateId,
  deletedAt: raw.deletedAt,
});

/** As regras de inclusão da lista e os filtros, como `WHERE` com parâmetros posicionais. */
function listWhere(filters: ScenePageFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [filters.formatIds];
  const conditions = [`s."deletedAt" IS NULL`, `s."formatId" = ANY($1::text[])`];
  if (filters.sceneId) {
    params.push(filters.sceneId);
    conditions.push(`s.id = $${params.length}::uuid`);
  }
  if (filters.search) {
    params.push(escapeLike(filters.search));
    conditions.push(`unaccent(s.name) ILIKE '%' || unaccent($${params.length}::text) || '%'`);
  }
  conditions.push(HAS_READY_FACE);
  return { where: conditions.join(' AND '), params };
}

/**
 * Leitura das tabelas das cenas (`template_scenes`, `template_scene_faces` e `templates`) pelo `manager` de quem chama,
 * só com `SELECT`. A `configuration` do template é reduzida no próprio SQL: só `source`, `header`, `footer` e a URL do
 * fundo chegam ao servidor.
 */
@Injectable()
export class FlyerProSceneReader {
  /** Uma página de cenas listáveis, por cena, e o total. Página vazia: o total vem de uma contagem à parte. */
  async listPage(
    manager: EntityManager,
    filters: ScenePageFilters,
  ): Promise<{ scenes: SceneRow[]; total: number }> {
    const { where, params } = listWhere(filters);
    const offset = (filters.page - 1) * filters.limit;
    const rows: Array<RawScene & { total: string }> = await manager.query(
      `SELECT ${SCENE_COLUMNS}, count(*) OVER () AS total
       FROM template_scenes s WHERE ${where}
       ORDER BY unaccent(lower(s.name)), s.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, offset],
    );
    if (rows.length > 0) return { scenes: rows.map(toSceneRow), total: Number(rows[0].total) };
    const [{ total }] = await manager.query(
      `SELECT count(*) AS total FROM template_scenes s WHERE ${where}`,
      params,
    );
    return { scenes: [], total: Number(total) };
  }

  /** A cena pelo id, inclusive a excluída (quem chama distingue); `null` se não existe. */
  async findScene(manager: EntityManager, sceneId: string): Promise<SceneRow | null> {
    if (!UUID_PATTERN.test(sceneId)) return null;
    const [row]: RawScene[] = await manager.query(
      `SELECT ${SCENE_COLUMNS} FROM template_scenes s WHERE s.id = $1::uuid`,
      [sceneId],
    );
    return row ? toSceneRow(row) : null;
  }

  async faceRows(manager: EntityManager, sceneIds: string[]): Promise<FaceRow[]> {
    return manager.query(
      `SELECT "sceneId", "index", key, label, "widthPx", "heightPx", "templateId"
       FROM template_scene_faces WHERE "sceneId" = ANY($1::uuid[]) ORDER BY "sceneId", "index"`,
      [sceneIds],
    );
  }

  async templateRows(manager: EntityManager, templateIds: string[]): Promise<TemplateRow[]> {
    if (templateIds.length === 0) return [];
    return manager.query(
      `SELECT id, "thumbnailUrl", configuration #>> '{bodyBackground,imageUrl}' AS "artUrl",
              configuration -> 'source' AS source, configuration -> 'header' AS header,
              configuration -> 'footer' AS footer
       FROM templates WHERE id = ANY($1::uuid[])`,
      [templateIds],
    );
  }
}
