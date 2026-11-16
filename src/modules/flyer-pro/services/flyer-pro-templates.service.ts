import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { paginate, PaginationResult } from '../../../common/utils/pagination.util';
import { FLYER_PRO_FORMAT_IDS, sceneFormatIdOf } from '../domain/flyer-pro-formats';
import { toTemplateEntry } from '../domain/flyer-pro-template-entry';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import type { FlyerProTemplateEntry, FlyerProTemplatesListInput } from '../domain/flyer-pro.types';
import { analyzeScenes } from './flyer-pro-scene-analysis';
import { FlyerProSceneReader } from './flyer-pro-scene.reader';
import { readWith } from './flyer-pro-read';

/** N7: os templates do Encarte Pro, uma entrada por cena do Templates v2. Leitura, sem gravar nada. */
@Injectable()
export class FlyerProTemplatesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reader: FlyerProSceneReader,
  ) {}

  async list(query: FlyerProTemplatesListInput): Promise<PaginationResult<FlyerProTemplateEntry>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? FLYER_PRO_LIMITS.listDefaultLimit;
    const formatIds = query.format ? [sceneFormatIdOf(query.format)] : FLYER_PRO_FORMAT_IDS;
    return readWith(this.dataSource, undefined, async (manager) => {
      const { scenes, total } = await this.reader.listPage(manager, {
        formatIds,
        search: query.search,
        sceneId: query.sceneId,
        page,
        limit,
      });
      const entries = (await analyzeScenes(this.reader, manager, scenes))
        .map(toTemplateEntry)
        .filter((entry): entry is FlyerProTemplateEntry => entry !== null);
      return paginate(entries, total, { page, limit });
    });
  }
}
