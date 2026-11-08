import { Inject, Injectable, Logger } from '@nestjs/common';
import { buildBackPrompt } from '../domain/scene-faces';
import { findSceneFormat } from '../domain/scene-formats';
import { SCENE_IMAGE_PROVIDER, SceneImageProvider } from '../providers/scene-image-provider';
import { DERIVE_BACK_REPLY } from '../scene-texts';
import { SceneCallRunner } from './scene-call-runner';
import { normalize } from './scene-redraw-conclude';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/**
 * O job do verso (`derive_face`, PV-6, PV-7): uma só chamada de edição de imagem, com a master atual da frente como
 * referência (só a master, sem achatar camadas nem elementos) e o prompt estrutural fixo do verso, no tamanho nativo e
 * na qualidade do redesenho. Sem juiz (PV: o prompt não pede texto) e sem camadas: o verso nasce vazio de camadas e o
 * pedido do cliente não entra no prompt. Falha, parada, custo, job repetido e reconciliador são os de qualquer turno
 * com imagem (`SceneCallRunner`, `SceneTurnState`).
 */
@Injectable()
export class SceneDeriveFaceHandler implements TurnHandler {
  private readonly logger = new Logger(SceneDeriveFaceHandler.name);

  constructor(
    private readonly support: SceneTurnSupport,
    private readonly calls: SceneCallRunner,
    @Inject(SCENE_IMAGE_PROVIDER) private readonly provider: SceneImageProvider,
  ) {}

  async run(ctx: TurnContext): Promise<void> {
    const { state } = this.support;
    const format = findSceneFormat(ctx.formatId);
    const master = await this.support.readMaster(ctx);
    if (!format || !master) {
      this.logger.error(`Frente ausente para derivar o verso (versão ${ctx.versionId})`);
      await state.fail(ctx, 'PROVIDER_ERROR');
      return;
    }
    if (!(await state.advance(ctx, 'editing'))) return;
    const prompt = buildBackPrompt({
      format,
      widthPx: ctx.widthPx,
      heightPx: ctx.heightPx,
      zones: ctx.zones,
    });
    const model = this.support.model();
    const size = `${ctx.widthPx}x${ctx.heightPx}`;
    const result = await this.calls.imageCall(ctx, {
      kind: 'edit',
      model,
      size,
      run: () =>
        this.provider.edit({
          model,
          prompt,
          size,
          quality: this.support.editQuality(),
          correlationId: ctx.correlationId,
          image: master,
        }),
    });
    if (!result) return;
    await this.support.finishWithImage(ctx, await normalize(ctx, result), {
      reply: DERIVE_BACK_REPLY,
      elements: [],
      keepBrief: true,
      metrics: { prompt, derivedFromVersionId: ctx.parent?.versionId ?? null },
    });
  }
}
