import { SendMessageDto } from '../dto/send-message.dto';
import { maskBounds, MIN_SHAPE_AREA_RATIO } from '../domain/scene-mask-shape';
import { rasterizeRegion, shapeAreaRatio } from '../domain/scene-shapes';
import { MaskShape, Rect } from '../domain/scene.types';
import { zoneRect } from '../domain/scene-faces';
import { EntityManager } from 'typeorm';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { invalidBody, regionTooSmall, targetElementNotFound } from '../scene.errors';

/** Conferência e leitura do alvo da mensagem (400 e 422), antes de qualquer consulta ao Diretor. */

const TARGET_KEYS = ['region', 'mask', 'zone', 'targetElementId'] as const;

/** Região, máscara, zona e elemento são alvos exclusivos (400, nada é gravado). */
export function assertSingleTarget(dto: SendMessageDto): void {
  const given = TARGET_KEYS.filter((key) => dto[key] !== undefined && dto[key] !== null);
  if (given.length > 1) {
    throw invalidBody(`Envie um alvo só: ${given.join(', ')} não podem vir juntos.`);
  }
  if (
    dto.region &&
    (dto.region.x + dto.region.w > 1.0001 || dto.region.y + dto.region.h > 1.0001)
  ) {
    throw invalidBody('A região passa da borda da imagem.');
  }
}

/** Área da forma acima de 0,1% da cena; o retângulo é conferido na conta, o pincel e o laço rasterizados. */
export async function assertShapeBigEnough(
  dto: SendMessageDto,
  scene: TemplateScene,
): Promise<void> {
  if (dto.region) {
    if (dto.region.w * dto.region.h < MIN_SHAPE_AREA_RATIO) throw regionTooSmall();
    return;
  }
  if (!dto.mask) return;
  const width = 256;
  const height = Math.max(1, Math.round((width * scene.heightPx) / scene.widthPx));
  const shape = await rasterizeRegion(dto.mask, width, height);
  if (shapeAreaRatio(shape) < MIN_SHAPE_AREA_RATIO) throw regionTooSmall();
}

/** O que a mensagem grava na versão: a marcação (retângulo, zona ou forma) e a dica de camada. */
export interface RequestedTarget {
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
}

/**
 * Marcação gravada na versão: retângulo e zona viram o retângulo (a zona é o retângulo do formato), a forma
 * guarda a forma e a caixa dela. `targetElementId` é só dica de camada: não é marcação e não gera `markup`.
 */
export function requestedTargetOf(
  dto: SendMessageDto,
  scene: TemplateScene,
  face: Pick<TemplateSceneFace, 'zones'>,
): RequestedTarget {
  const none: RequestedTarget = {
    requestedRegion: null,
    requestedMask: null,
    targetElementId: null,
  };
  if (dto.region) return { ...none, requestedRegion: dto.region };
  // Zona que a face não tem (rodapé na frente, cabeçalho no verso) vale como miolo (PV-9).
  if (dto.zone) return { ...none, requestedRegion: zoneRect(face.zones, dto.zone) };
  if (dto.mask) {
    return {
      ...none,
      requestedMask: dto.mask,
      requestedRegion: maskBounds(dto.mask, scene.heightPx / scene.widthPx),
    };
  }
  return { ...none, targetElementId: dto.targetElementId ?? null };
}

/** `targetElementId` precisa ser uma camada da versão atual da face (422 `TARGET_ELEMENT_NOT_FOUND`). */
export async function assertTargetElementExists(
  manager: EntityManager,
  face: Pick<TemplateSceneFace, 'currentVersionId'>,
  dto: SendMessageDto,
): Promise<void> {
  if (!dto.targetElementId) return;
  const current = face.currentVersionId
    ? await manager.findOne(TemplateSceneVersion, { where: { id: face.currentVersionId } })
    : null;
  if (!current?.elements.some((element) => element.id === dto.targetElementId)) {
    throw targetElementNotFound(dto.targetElementId);
  }
}
