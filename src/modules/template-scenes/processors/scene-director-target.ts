import { EntityManager } from 'typeorm';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { rejectVersion } from './scene-turn-complete';

/** O que cada efeito do turno recebe: o gerenciador da transação sob o lock, a cena e a versão de leitura. */
export interface DirectorTarget {
  manager: EntityManager;
  scene: TemplateScene;
  version: TemplateSceneVersion;
}

/** Resposta ao cliente sem imagem: a versão de leitura termina `rejected` com o texto. */
export async function rejectTarget(target: DirectorTarget, reply: string): Promise<void> {
  const { manager, scene, version } = target;
  await manager.save(version);
  await manager.save(scene);
  await rejectVersion(manager, scene, version, reply);
}
