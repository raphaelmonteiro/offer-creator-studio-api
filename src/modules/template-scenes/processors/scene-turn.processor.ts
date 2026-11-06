import { Injectable, Logger } from '@nestjs/common';
import { SceneFailureCode } from '../domain/scene.types';
import { SceneRedrawHandler } from './scene-redraw.handler';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnState, TurnContext } from './scene-turn-state';

export interface SceneTurnJob {
  sceneId: string;
  versionId: string;
}

/**
 * Consumer de `template_scene.turn`. Escolhe o tratador pela operação gravada na versão:
 * `generate` (primeira geração e ajuste geral), `local_edit`, `set_layer` e `add_element`. Regras
 * comuns a todos:
 * - a tentativa é gravada ANTES da chamada paga (R10) e fechada depois com o custo do `usage`;
 * - nunca lança depois de uma chamada paga: qualquer erro vira `failed` com o código e o custo, e o
 *   job termina com sucesso (a fila não repete chamada paga);
 * - o cancelamento é conferido antes de cada etapa e logo depois da chamada (resultado descartado,
 *   custo gravado);
 * - job repetido (versão fora de `queued`) sai sem chamar o provedor.
 */
@Injectable()
export class SceneTurnProcessor {
  private readonly logger = new Logger(SceneTurnProcessor.name);

  constructor(
    private readonly state: SceneTurnState,
    private readonly redraw: SceneRedrawHandler,
  ) {}

  async process(job: SceneTurnJob, jobId?: string): Promise<void> {
    let ctx: TurnContext | null = null;
    try {
      ctx = await this.state.begin(job.sceneId, job.versionId);
      if (!ctx) {
        this.logger.log(`Job ${jobId ?? '?'} ignorado: versão ${job.versionId} não está pendente`);
        return;
      }
      await this.handlerFor(ctx).run(ctx);
    } catch (error) {
      this.logger.error(
        `Turno da cena ${job.sceneId} falhou (versão ${job.versionId}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (ctx) await this.failSafely(ctx, 'PROVIDER_ERROR');
    }
  }

  private handlerFor(ctx: TurnContext): TurnHandler {
    switch (ctx.operation) {
      case 'generate':
      case 'redraw':
        return this.redraw;
      default:
        // Job antigo na fila: hoje o `default` geraria imagem para uma operação que não existe mais.
        return { run: (turn) => this.failWithoutCall(turn) };
    }
  }

  private async failWithoutCall(ctx: TurnContext): Promise<void> {
    this.logger.error(
      `Operação "${ctx.operation}" não é mais processada (versão ${ctx.versionId}): falha sem chamada paga`,
    );
    await this.state.fail(ctx, 'PROVIDER_ERROR');
  }

  /** Último recurso: marca a versão como falha; se nem isso der, o reconciliador resolve. */
  private async failSafely(ctx: TurnContext, code: SceneFailureCode): Promise<void> {
    try {
      await this.state.fail(ctx, code);
    } catch (error) {
      this.logger.error(
        `Não foi possível marcar a versão ${ctx.versionId} como falha: ${(error as Error).message}`,
      );
    }
  }
}
