import { EntityManager } from 'typeorm';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  FIRST_IMAGE_REPLY,
  versionIsCurrentReply,
  versionMissingReply,
  versionPurgedReply,
} from '../scene-texts';
import { DisplayedVersion, loadDisplayedVersions } from './scene-display-number';
import { currentVersionOf } from './scene-faces';
import { masterOnDisk } from './scene-restore';

/** A origem da restauração, ou a resposta ao cliente quando não há como voltar. */
export type UndoResolution =
  | { kind: 'restore'; source: TemplateSceneVersion; sourceDisplayNumber: number }
  | { kind: 'reply'; reply: string };

const sameImage = (a: TemplateSceneVersion, b: TemplateSceneVersion): boolean =>
  a.masterAssetId === b.masterAssetId && JSON.stringify(a.elements) === JSON.stringify(b.elements);

/** Números exibidos das versões com a master ainda em disco, para citar ao cliente o que dá para restaurar. */
async function availableNumbers(
  manager: EntityManager,
  displayed: DisplayedVersion[],
): Promise<number[]> {
  const numbers: number[] = [];
  for (const version of displayed) {
    const row = await manager.findOneByOrFail(TemplateSceneVersion, { id: version.id });
    if (await masterOnDisk(manager, row)) numbers.push(version.displayNumber);
  }
  return numbers;
}

/**
 * `previous`: sobe por `parentVersionId` a partir da atual até a primeira versão `ready` com master ou camadas
 * diferentes. Assim, um segundo "volta" não reencontra a mesma imagem: a restauração tem como pai a origem, que
 * é igual a ela, e a subida segue.
 */
async function previousOf(
  manager: EntityManager,
  current: TemplateSceneVersion,
): Promise<TemplateSceneVersion | null> {
  const seen = new Set<string>([current.id]);
  let cursor = current.parentVersionId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const version = await manager.findOne(TemplateSceneVersion, { where: { id: cursor } });
    if (!version) return null;
    if (version.status === 'ready' && version.masterAssetId && !sameImage(version, current)) {
      return version;
    }
    cursor = version.parentVersionId;
  }
  return null;
}

/**
 * Resolve o alvo do "volta" do Diretor na face do pedido: `previous` ou o número exibido (validado contra as versões
 * da face, PV-4). Nada aqui chama o modelo de imagem. Master apagada, versão inexistente ou já na primeira terminam com
 * a resposta ao cliente, e a versão de leitura fica `rejected`.
 */
export async function resolveUndo(
  manager: EntityManager,
  face: Pick<TemplateSceneFace, 'sceneId' | 'index' | 'currentVersionId'>,
  target: 'previous' | number,
): Promise<UndoResolution> {
  const displayed = await loadDisplayedVersions(manager, face.sceneId, face.index);
  const current = await currentVersionOf(manager, face);
  if (!current) return { kind: 'reply', reply: FIRST_IMAGE_REPLY };
  let source: TemplateSceneVersion | null;
  if (target === 'previous') {
    source = await previousOf(manager, current);
    if (!source) return { kind: 'reply', reply: FIRST_IMAGE_REPLY };
  } else {
    const found = displayed.find((version) => version.displayNumber === target);
    if (!found) {
      return {
        kind: 'reply',
        reply: versionMissingReply(target, await availableNumbers(manager, displayed)),
      };
    }
    if (found.id === current.id) return { kind: 'reply', reply: versionIsCurrentReply(target) };
    source = await manager.findOneByOrFail(TemplateSceneVersion, { id: found.id });
  }
  if (!(await masterOnDisk(manager, source))) {
    return { kind: 'reply', reply: versionPurgedReply(await availableNumbers(manager, displayed)) };
  }
  const shown = displayed.find((version) => version.id === (source as TemplateSceneVersion).id);
  return { kind: 'restore', source, sourceDisplayNumber: shown?.displayNumber ?? 0 };
}
