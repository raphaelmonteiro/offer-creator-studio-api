import { fold } from '../../../shared/text/fold';
import { layerOpsToActions } from '../domain/scene-director-layers';
import { describeLayerDiff } from '../domain/scene-layer-diff';
import { sceneZonesFor } from '../domain/scene-formats';
import { SceneElement } from '../domain/scene.types';
import { applyLayerActions } from './scene-layer-actions';
import { colorNewTexts } from './scene-layer-color';
import { DirectorPlan } from '../domain/scene-director-schema';
import { TurnContext } from './scene-turn-state';

/**
 * Camadas de um plano que também chama imagem (defeito b, D-55): o código aplica as ações às camadas da versão atual
 * quando a imagem é salva, e a camada de texto cuja frase é igual a uma linha pintada nesta rodada sai na mesma versão
 * ("volta" a traz de novo). Imagem que falhou ou foi parada não chega aqui: nenhuma ação de camada é aplicada.
 */
export async function planLayers(
  ctx: TurnContext,
  plan: DirectorPlan,
  png: Buffer,
): Promise<{ elements: SceneElement[]; note: string } | null> {
  const base = ctx.parent?.elements ?? [];
  const painted = new Set((plan.image?.exact_text ?? []).map((line) => fold(line.trim())));
  const withoutPainted = base.filter(
    (element) => !(element.kind === 'text' && painted.has(fold((element.text ?? '').trim()))),
  );
  const zones = sceneZonesFor(ctx.formatId);
  let elements = withoutPainted;
  let failure = '';
  if (plan.layer_ops.length) {
    const converted = layerOpsToActions(plan.layer_ops, {
      elements: withoutPainted,
      attachmentId: ctx.attachments[0]?.id ?? null,
      hintElementId: ctx.targetElementId,
    });
    const applied =
      converted.ok === false
        ? converted
        : applyLayerActions(converted.actions, {
            zones,
            widthPx: ctx.widthPx,
            heightPx: ctx.heightPx,
            elements: withoutPainted,
            attachments: ctx.attachments,
          });
    if (applied.ok === true) {
      elements = await colorNewTexts(withoutPainted, applied.elements, {
        master: png,
        widthPx: ctx.widthPx,
        heightPx: ctx.heightPx,
      });
    } else {
      failure = `Não mexi nas camadas: ${applied.reply.replace(/ Nada foi alterado\.?$/, '')}`;
    }
  }
  const diff = describeLayerDiff(base, elements, zones);
  const note = [diff.text, failure].filter(Boolean).join(' ');
  return diff.changed || failure ? { elements, note } : null;
}
