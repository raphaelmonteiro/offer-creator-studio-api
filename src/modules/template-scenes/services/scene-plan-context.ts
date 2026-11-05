import { EntityManager } from 'typeorm';
import { SendMessageDto } from '../dto/send-message.dto';
import { ClassifierTargetElement, LocalTarget } from '../domain/scene-operation.classifier';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { targetElementNotFound } from '../scene.errors';

/** Camadas da versão atual da cena. */
export async function currentElements(
  manager: EntityManager,
  scene: TemplateScene,
): Promise<SceneElement[]> {
  if (!scene.currentVersionId) return [];
  const current = await manager.findOne(TemplateSceneVersion, {
    where: { id: scene.currentVersionId },
  });
  return current?.elements ?? [];
}

/** O elemento selecionado na prévia (404 se não existe na versão atual). */
export async function selectedElement(
  manager: EntityManager,
  scene: TemplateScene,
  elementId: string | undefined,
): Promise<ClassifierTargetElement | undefined> {
  if (!elementId) return undefined;
  const element = (await currentElements(manager, scene)).find((e) => e.id === elementId);
  if (!element) throw targetElementNotFound(elementId);
  return { id: element.id, kind: element.kind };
}

/** A marcação do pedido: forma, retângulo ou o campo `zone`; `null` sem nenhuma (o elemento selecionado não é marcação). */
export function markedTargetOf(dto: SendMessageDto): LocalTarget | null {
  if (dto.mask) return { kind: 'mask', mask: dto.mask };
  if (dto.region) return { kind: 'rect', rect: dto.region };
  if (dto.zone) return { kind: 'zone', zone: dto.zone, from: 'field' };
  return null;
}
