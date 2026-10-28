import { EntityManager } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';

/**
 * Manager fake em memória: `saved` guarda entidades; find/findOne filtram por
 * igualdade rasa das chaves do `where`; o QueryBuilder do cache é
 * configurável. Suficiente para provar a materialização v2 sem banco.
 */
export function fakeManager(
  opts: {
    cache?: Array<{ id: string; outputAssetId: string } | null>;
    assets?: Partial<AnimationAsset>[];
  } = {},
) {
  let seq = 0;
  const rows = new Map<unknown, Array<Record<string, unknown>>>();
  const table = (entity: unknown) => {
    if (!rows.has(entity)) rows.set(entity, []);
    return rows.get(entity)!;
  };
  if (opts.assets) rows.set(AnimationAsset, opts.assets as Array<Record<string, unknown>>);
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const value = row[k];
      if (v && typeof v === 'object' && '_type' in (v as object)) {
        // TypeORM In(): { _type: 'in', _value: [...] }
        return ((v as { _value: unknown[] })._value ?? []).includes(value);
      }
      return value === v;
    });
  const cacheResults = [...(opts.cache ?? [])];
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve(cacheResults.shift() ?? null)),
  };
  const manager = {
    rows,
    create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
    save: jest.fn((obj: Record<string, unknown> & { id?: string }) => {
      if (!obj.id) obj.id = `id-${++seq}`;
      const entity =
        'inputHash' in obj
          ? McStep
          : 'scriptSceneId' in obj || 'rerollCount' in obj
            ? McScene
            : McProject;
      const list = table(entity);
      const existing = list.findIndex((r) => r.id === obj.id);
      if (existing >= 0) list[existing] = obj;
      else list.push(obj);
      return Promise.resolve(obj);
    }),
    update: jest.fn(
      (entity: unknown, where: Record<string, unknown>, patch: Record<string, unknown>) => {
        let affected = 0;
        for (const row of table(entity)) {
          if (matches(row, where)) {
            Object.assign(row, patch);
            affected += 1;
          }
        }
        return Promise.resolve({ affected });
      },
    ),
    find: jest.fn((entity: unknown, options: { where: Record<string, unknown>; order?: unknown }) =>
      Promise.resolve(table(entity).filter((r) => matches(r, options.where ?? {}))),
    ),
    findOne: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) =>
      Promise.resolve(table(entity).find((r) => matches(r, options.where ?? {})) ?? null),
    ),
    createQueryBuilder: jest.fn(() => qb),
    seed(entity: unknown, list: Array<Record<string, unknown>>) {
      rows.set(entity, list);
    },
    steps: () => table(McStep) as unknown as McStep[],
    scenes: () => table(McScene) as unknown as McScene[],
  };
  return manager as unknown as EntityManager & typeof manager;
}
