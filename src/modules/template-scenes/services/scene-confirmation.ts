import { EntityManager } from 'typeorm';
import { SendMessageDto } from '../dto/send-message.dto';
import { LocalTarget, SceneClassification } from '../domain/scene-operation.classifier';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { confirmationNotPending } from '../scene.errors';

/** Tipo da pergunta: ajuste geral, imagem nova (D-18) ou edição da área marcada (falha da intenção, D-19). */
export type ConfirmationKind = 'global' | 'new_image' | 'edit';

/** O que a pergunta guarda na versão `rejected` para o "Confirmar" seguir sem reclassificar (R23). */
export interface PendingConfirmation {
  request: string;
  /** Perguntas gravadas antes da D-18 são do ajuste geral. */
  kind?: ConfirmationKind;
  /** Só na pergunta de `edit`: a confirmação não traz área, então o alvo fica guardado. */
  target?: LocalTarget;
  consumedByMessageId?: string;
}

/**
 * Resposta do assistente à pergunta que se confirma: acha a mensagem, confere que a pergunta ainda está
 * pendente e a marca como respondida (mesma transação do envio).
 */
export async function consumeConfirmation(
  manager: EntityManager,
  scene: TemplateScene,
  dto: SendMessageDto,
): Promise<PendingConfirmation> {
  const reply = await manager.findOne(TemplateSceneMessage, {
    where: { id: dto.replyToMessageId, sceneId: scene.id, role: 'assistant' },
  });
  const version = reply?.versionId
    ? await manager.findOne(TemplateSceneVersion, { where: { id: reply.versionId } })
    : null;
  const pending = version?.metrics.pendingConfirmation as PendingConfirmation | undefined;
  if (!version || version.status !== 'rejected' || !pending || pending.consumedByMessageId) {
    throw confirmationNotPending();
  }
  version.metrics = {
    ...version.metrics,
    pendingConfirmation: { ...pending, consumedByMessageId: reply!.id },
  };
  await manager.save(version);
  return pending;
}

/** O plano da confirmação: o que a pergunta guardou, sem passar pelo modelo nem pelas regras (R23). */
export function planOfConfirmation(pending: PendingConfirmation): SceneClassification {
  const instruction = pending.request;
  if (pending.kind === 'new_image') return { operation: 'new_image', instruction };
  if (pending.kind === 'edit' && pending.target) {
    return { operation: 'local_edit', target: pending.target, instruction, remove: false };
  }
  return { operation: 'global_regenerate', instruction };
}
