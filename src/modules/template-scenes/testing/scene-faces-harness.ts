import { findSceneFormat, SceneFormatSpec } from '../domain/scene-formats';
import { tabloidZones } from '../domain/scene-tabloid';
import { SceneZones } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { useDirectorHarness } from './scene-director-harness';
import { insertScene, pointFace } from './scene-fixtures';
import { syntheticScenePng } from './synthetic-scene';

/** Tamanho das cenas de frente e verso dos testes: a proporção do `folheto-27x40`, leve para o `sharp`. */
export const FB_WIDTH = 392;
export const FB_HEIGHT = 584;

/** Master dos testes do jornal: no tamanho nativo do 54x40, porque o prompt de edição escreve as medidas da master. */
export const TB_MASTER_WIDTH = 3328;
export const TB_MASTER_HEIGHT = 2480;

/**
 * Banco, arquivos em pasta temporária, o Diretor e o job de imagem, com atalhos para a cena de frente e verso
 * (`folheto-27x40`, `front_back`). Chame dentro do `describeIfSceneDb`.
 */
export function useFacesHarness() {
  const h = useDirectorHarness();

  /** Versão `ready` da face, com master e prévia reais em disco, apontada como a atual da face. */
  async function readyOnFace(
    scene: TemplateScene,
    face: { index: number; number: number; parentVersionId?: string | null },
  ): Promise<TemplateSceneVersion> {
    const made = await h.readyVersionLike(
      scene,
      face.number,
      face.parentVersionId ?? null,
      await syntheticScenePng(FB_WIDTH, FB_HEIGHT),
      [],
      { faceIndex: face.index },
    );
    await pointFace(h.dataSource, scene, made.version.id, face.index);
    return made.version;
  }

  /**
   * Cena de frente e verso (`folheto-27x40`), sem versão; `front` e `back` dão uma versão `ready` (a frente com o
   * número 1, o verso com o 2) apontada como a atual da face.
   */
  async function frontBackScene(options: { front?: boolean; back?: boolean; name?: string } = {}) {
    const scene = await insertScene(h.dataSource, {
      name: options.name ?? 'São João',
      layout: 'front_back',
      formatId: 'folheto-27x40',
      artWidthCm: 27.5,
      artHeightCm: 41,
      widthPx: FB_WIDTH,
      heightPx: FB_HEIGHT,
      pixelsPerCm: 14.2545,
    });
    h.trackScene(scene.id);
    const front = options.front ? await readyOnFace(scene, { index: 0, number: 1 }) : null;
    const back = options.back ? await readyOnFace(scene, { index: 1, number: 2 }) : null;
    return { scene, front, back };
  }

  /**
   * Jornal (`folheto-54x40`, `tabloid`), sem versão; `outer` e `inner` dão uma versão `ready` (a Externa com o número 1,
   * a Interna com o 2) apontada como a atual da face. `headerCm` muda a altura do cabeçalho na face e na versão da
   * Externa (a versão guarda as zonas, PV-T10).
   */
  async function tabloidScene(
    options: { outer?: boolean; inner?: boolean; headerCm?: number; name?: string } = {},
  ) {
    const scene = await insertScene(h.dataSource, {
      name: options.name ?? 'Aniversário',
      layout: 'tabloid',
      formatId: 'folheto-54x40',
      artWidthCm: 55,
      artHeightCm: 41,
      widthPx: 3328,
      heightPx: 2480,
      pixelsPerCm: 60.5,
    });
    h.trackScene(scene.id);
    const zones = options.headerCm
      ? tabloidZones(findSceneFormat('folheto-54x40') as SceneFormatSpec, 'outer', options.headerCm)
      : null;
    const png = await syntheticScenePng(TB_MASTER_WIDTH, TB_MASTER_HEIGHT);
    const ready = async (face: { index: number; number: number }, faceZones: SceneZones | null) => {
      const made = await h.readyVersionLike(scene, face.number, null, png, [], {
        faceIndex: face.index,
        zones: faceZones,
      });
      await pointFace(h.dataSource, scene, made.version.id, face.index);
      if (faceZones && face.index === 0) {
        await h.dataSource.manager.update(
          TemplateSceneFace,
          { sceneId: scene.id, index: 0 },
          { zones: faceZones },
        );
      }
      return made.version;
    };
    const outer = options.outer ? await ready({ index: 0, number: 1 }, zones) : null;
    const inner = options.inner ? await ready({ index: 1, number: 2 }, null) : null;
    return { scene, outer, inner };
  }

  return Object.assign(h, { readyOnFace, frontBackScene, tabloidScene });
}
