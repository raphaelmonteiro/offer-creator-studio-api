import { Injectable, Logger } from '@nestjs/common';
import { layerReply } from '../scene-texts';
import { applyLayerActions } from './scene-layer-actions';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/**
 * `set_layer` pelo chat: logo (clipe), texto entre aspas ou "escreve", e mover, redimensionar ou tirar
 * uma camada. Não chama o modelo (custo 0): a versão aponta para a master da versão de origem e só as
 * camadas mudam. Alvo ausente ou ambíguo termina em `rejected` com a resposta no chat.
 */
@Injectable()
export class SceneLayerHandler implements TurnHandler {
  private readonly logger = new Logger(SceneLayerHandler.name);

  constructor(private readonly support: SceneTurnSupport) {}

  async run(ctx: TurnContext): Promise<void> {
    const { state } = this.support;
    const plan = ctx.plan;
    if (plan?.operation !== 'set_layer' || !ctx.parent) {
      this.logger.error(`Camada sem versão de origem ou sem plano (versão ${ctx.versionId})`);
      return state.fail(ctx, 'PROVIDER_ERROR');
    }
    const result = applyLayerActions(plan.actions, {
      zones: ctx.zones,
      widthPx: ctx.widthPx,
      heightPx: ctx.heightPx,
      elements: ctx.parent.elements,
      attachments: ctx.attachmentAssets,
    });
    if (result.ok === false) return state.reject(ctx, result.reply);
    if (!(await state.advance(ctx, 'saving'))) return;
    await state.completeReusingImage(ctx, {
      elements: result.elements,
      reply: layerReply(result.changed),
      metrics: { layer: { changed: result.changed } },
    });
  }
}
