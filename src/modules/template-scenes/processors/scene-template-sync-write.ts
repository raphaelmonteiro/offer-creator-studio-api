import { EntityManager } from 'typeorm';
import { SceneTemplateConfiguration } from '../domain/scene-template.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { Template } from '../../templates/entities/template.entity';
import { faceTemplateIdOf, setFaceTemplate } from '../services/scene-faces';
import { ProjectedTemplate } from '../services/scene-template-projection';

/** Mesmo limite do `TemplatesService` para a configuração (10 MB de JSON). */
const MAX_CONFIGURATION_BYTES = 10 * 1024 * 1024;

/** A face do jeito que o job a leu, para conferir sob a trava que nada mudou (PV-13). */
export interface ReadState {
  versionId: string;
  revision: number;
  templateId: string | null;
}

/**
 * Cena excluída ou mudada desde a leitura: o resultado é descartado, sem erro. A conferência é da versão atual da
 * face e do template dela, e da `revision` da cena (D-1).
 */
export const isStale = (
  scene: TemplateScene,
  face: Pick<TemplateSceneFace, 'index' | 'currentVersionId' | 'templateId'>,
  read: ReadState,
): boolean =>
  Boolean(scene.deletedAt) ||
  face.currentVersionId !== read.versionId ||
  scene.revision !== read.revision ||
  faceTemplateIdOf(scene, face) !== read.templateId;

/**
 * Cria ou atualiza o template da face pelo `manager` da transação (a mesma da trava), grava o template da face
 * (`face.templateId`, e `approvedTemplateId` na face 0) e `approvedAt` com `UPDATE` direto, sem `bumpRevision` e sem
 * evento (a tela da cena não muda e ninguém recebe `REVISION_CONFLICT`), e limpa a falha registrada da versão
 * (PV-13, PV-15).
 */
export async function writeSceneTemplate(
  manager: EntityManager,
  input: {
    scene: TemplateScene;
    face: TemplateSceneFace;
    versionId: string;
    name: string;
    projected: ProjectedTemplate;
  },
): Promise<Template> {
  const { scene, face, versionId, name, projected } = input;
  const configuration: SceneTemplateConfiguration = projected.configuration;
  const bytes = Buffer.byteLength(JSON.stringify(configuration));
  if (bytes > MAX_CONFIGURATION_BYTES) {
    throw new Error(`Configuração do template grande demais: ${bytes} bytes`);
  }
  const templateId = faceTemplateIdOf(scene, face);
  const existing = templateId ? await manager.findOneBy(Template, { id: templateId }) : null;
  const template = existing
    ? Object.assign(existing, { name, configuration, thumbnailUrl: projected.thumbnailUrl })
    : manager.create(Template, {
        name,
        type: 'full',
        isDefault: false,
        configuration,
        thumbnailUrl: projected.thumbnailUrl,
      });
  const saved = await manager.save(template);
  await setFaceTemplate(manager, scene, face.index, saved.id);
  await manager.query(`UPDATE template_scenes SET "approvedAt" = now() WHERE id = $1`, [scene.id]);
  await manager.query(
    `UPDATE template_scene_versions SET metrics = metrics - 'templateSync'
     WHERE id = $1 AND metrics->'templateSync' IS NOT NULL`,
    [versionId],
  );
  return saved;
}
