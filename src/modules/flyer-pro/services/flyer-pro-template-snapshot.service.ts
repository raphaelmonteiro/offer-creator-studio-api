import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  flyerProTemplateIncomplete,
  flyerProTemplateNotFound,
  flyerProTemplateUnsupported,
} from '../domain/flyer-pro.errors';
import type { FlyerProTemplateSnapshot } from '../domain/flyer-pro.types';
import {
  isFormatSupported,
  SceneTemplateAnalysis,
  SupportedFormatAnalysis,
  toTemplateSnapshot,
} from '../domain/flyer-pro-template-entry';
import { analyzeScenes } from './flyer-pro-scene-analysis';
import { FlyerProSceneReader } from './flyer-pro-scene.reader';
import { readWith } from './flyer-pro-read';

/**
 * A cópia congelada do template de uma cena (`templateSnapshot`) e o estado dela em relação à cena de hoje. Só lê as
 * tabelas das cenas, nunca grava; a regra é a mesma função pura da lista (N7). Quem grava e devolve a cópia chega nas
 * changes 08 (N1 e N3) e 09 (ramo `setup` do N4).
 */
@Injectable()
export class FlyerProTemplateSnapshotService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reader: FlyerProSceneReader,
  ) {}

  /**
   * Monta a cópia pelo estado atual da cena. Recusa, nesta ordem: 404 `FLYER_PRO_TEMPLATE_NOT_FOUND` (cena inexistente,
   * excluída ou sem nenhuma face pronta), 422 `FLYER_PRO_TEMPLATE_UNSUPPORTED` e 422 `FLYER_PRO_TEMPLATE_INCOMPLETE`.
   * Com `manager`, lê dentro da transação de quem chama; sem ele, numa transação própria de leitura (A-10).
   */
  async build(sceneId: string, manager?: EntityManager): Promise<FlyerProTemplateSnapshot> {
    return readWith(this.dataSource, manager, async (reading) => {
      const analysis = await this.analysisOf(reading, sceneId);
      const supported = assertBuildable(analysis);
      return toTemplateSnapshot(supported, new Date().toISOString());
    });
  }

  /** A cena de hoje, inclusive a excluída (quem chama distingue); `null` se não existe. */
  private async analysisOf(
    manager: EntityManager,
    sceneId: string,
  ): Promise<SceneTemplateAnalysis | null> {
    const scene = await this.reader.findScene(manager, sceneId);
    if (!scene) return null;
    const [analysis] = await analyzeScenes(this.reader, manager, [scene]);
    return analysis;
  }
}

/** As três recusas da montagem, na ordem da spec; devolve a análise com o formato garantido. */
function assertBuildable(analysis: SceneTemplateAnalysis | null): SupportedFormatAnalysis {
  if (!analysis || analysis.scene.deletedAt || analysis.faces.length === 0) {
    throw flyerProTemplateNotFound();
  }
  if (!isFormatSupported(analysis) || analysis.unsupported) {
    throw flyerProTemplateUnsupported({
      reason: analysis.unsupported ?? 'FORMAT',
      formatId: analysis.scene.formatId,
      layout: analysis.scene.layout,
    });
  }
  if (analysis.missingFaces.length > 0) throw flyerProTemplateIncomplete(analysis.missingFaces);
  return analysis;
}
