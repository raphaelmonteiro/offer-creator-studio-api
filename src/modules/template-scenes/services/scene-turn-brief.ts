import { EntityManager } from 'typeorm';
import { adoptOpenItems, supersedeAtTurnEnd } from '../domain/scene-brief';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/**
 * Fim de todo turno (D-59), sob o lock da cena e antes de gravar a versão: o item aberto que não é da mensagem do
 * turno fica `superseded`, e Parar (`stopped`) fecha também os do turno parado. Muda `scene.brief` em memória (quem
 * grava é o `bumpRevision` que fecha o turno) e deixa o que mudou em `metrics.briefSuperseded`, para a auditoria.
 */
async function messageOf(
  manager: EntityManager,
  version: TemplateSceneVersion,
): Promise<TemplateSceneMessage | null> {
  return manager.findOne(TemplateSceneMessage, {
    where: { versionId: version.id, role: 'user' },
    order: { createdAt: 'ASC' },
  });
}

/** O turno pergunta qual item o cliente quer esquecer: os itens citados passam a ser do turno e não ficam superados. */
export async function keepOpenItems(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
): Promise<void> {
  const message = await messageOf(manager, version);
  scene.brief = adoptOpenItems(scene.brief ?? [], {
    messageId: message?.id ?? '',
    now: new Date(),
  });
}

export async function closeTurnBrief(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
  options: { stopped?: boolean } = {},
): Promise<void> {
  const message = await messageOf(manager, version);
  const closed = supersedeAtTurnEnd(scene.brief ?? [], {
    messageId: message?.id ?? '',
    now: new Date(),
    stopped: options.stopped,
  });
  if (closed.changes.superseded.length === 0) return;
  scene.brief = closed.brief;
  version.metrics = { ...version.metrics, briefSuperseded: closed.changes.superseded };
}
