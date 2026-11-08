import { EntityManager } from 'typeorm';
import { SceneTemplateConfiguration } from '../domain/scene-template.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { Template } from '../../templates/entities/template.entity';
import { ProjectedTemplate } from '../services/scene-template-projection';

/** Mesmo limite do `TemplatesService` para a configuração (10 MB de JSON). */
const MAX_CONFIGURATION_BYTES = 10 * 1024 * 1024;

/** A cena do jeito que o job a leu, para conferir sob a trava que nada mudou (PV-13). */
export interface ReadState {
  versionId: string;
  revision: number;
  approvedTemplateId: string | null;
}

/** Cena excluída ou mudada desde a leitura: o resultado é descartado, sem erro. */
export const isStale = (scene: TemplateScene, read: ReadState): boolean =>
  Boolean(scene.deletedAt) ||
  scene.currentVersionId !== read.versionId ||
  scene.revision !== read.revision ||
  scene.approvedTemplateId !== read.approvedTemplateId;

/**
 * Cria ou atualiza o template da cena pelo `manager` da transação (a mesma da trava), grava `approvedTemplateId` e
 * `approvedAt` com `UPDATE` direto, sem `bumpRevision` e sem evento (a tela da cena não muda e ninguém recebe
 * `REVISION_CONFLICT`), e limpa a falha registrada da versão (PV-13, PV-15).
 */
export async function writeSceneTemplate(
  manager: EntityManager,
  input: { scene: TemplateScene; versionId: string; name: string; projected: ProjectedTemplate },
): Promise<Template> {
  const { scene, versionId, name, projected } = input;
  const configuration: SceneTemplateConfiguration = projected.configuration;
  const bytes = Buffer.byteLength(JSON.stringify(configuration));
  if (bytes > MAX_CONFIGURATION_BYTES) {
    throw new Error(`Configuração do template grande demais: ${bytes} bytes`);
  }
  const existing = scene.approvedTemplateId
    ? await manager.findOneBy(Template, { id: scene.approvedTemplateId })
    : null;
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
  await manager.query(
    `UPDATE template_scenes SET "approvedTemplateId" = $1, "approvedAt" = now() WHERE id = $2`,
    [saved.id, scene.id],
  );
  await manager.query(
    `UPDATE template_scene_versions SET metrics = metrics - 'templateSync'
     WHERE id = $1 AND metrics->'templateSync' IS NOT NULL`,
    [versionId],
  );
  return saved;
}
