import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SceneCallRecord } from '../domain/scene.types';
import { SceneGenerateResult, SceneProviderError } from '../providers/scene-image-provider';
import { VisionAssessment } from '../services/scene-vision.service';
import { CallOutcome, SceneTurnState, TurnContext } from './scene-turn-state';

const DEFAULT_MAX_PAID_CALLS = 4;

/** O que uma chamada de imagem precisa para ser reservada, executada e gravada. */
export interface ImageCallSpec {
  kind: Extract<SceneCallRecord['kind'], 'generate' | 'edit' | 'transparent'>;
  model: string;
  size: string;
  run: () => Promise<SceneGenerateResult>;
}

/** Resultado de uma chamada opcional: valor, "pulada pelo limite" ou "o turno acabou". */
export type OptionalCall<T> =
  | { status: 'ok'; value: T }
  | { status: 'skipped' }
  | { status: 'over' };

/**
 * Executa as chamadas pagas do turno com as garantias do estágio 3 (R10) e do disjuntor:
 * - a tentativa é gravada ANTES da chamada e fechada depois com o custo (`usage`), por etapa;
 * - uma chamada de imagem barrada pelo limite falha a versão com `PAID_CALL_LIMIT`;
 * - a visão é opcional: se passar do limite, é pulada e a edição vale;
 * - falha do provedor fecha a tentativa e a versão com o código classificado.
 */
@Injectable()
export class SceneCallRunner {
  private readonly logger = new Logger(SceneCallRunner.name);

  constructor(
    private readonly state: SceneTurnState,
    private readonly config: ConfigService,
  ) {}

  maxPaidCalls(): number {
    const value = Number(
      this.config.get<string>(
        'TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE',
        String(DEFAULT_MAX_PAID_CALLS),
      ),
    );
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_PAID_CALLS;
  }

  private pending(spec: Pick<SceneCallRecord, 'kind' | 'model' | 'size'>): SceneCallRecord {
    return {
      id: randomUUID(),
      status: 'pending',
      startedAt: new Date().toISOString(),
      ...spec,
    };
  }

  /** `null` = o turno acabou (cancelado, limite, falha do provedor); a versão já foi fechada. */
  async imageCall(ctx: TurnContext, spec: ImageCallSpec): Promise<SceneGenerateResult | null> {
    const call = this.pending(spec);
    if ((await this.state.reserveCall(ctx, call, this.maxPaidCalls())) !== 'ok') return null;
    let result: SceneGenerateResult;
    try {
      result = await spec.run();
    } catch (error) {
      const failure =
        error instanceof SceneProviderError
          ? error
          : new SceneProviderError('PROVIDER_ERROR', (error as Error).message);
      this.logProviderFailure(ctx, failure);
      await this.state.closeCall(ctx, call.id, {
        status: 'failed',
        costUsd: failure.costUsd ?? 0,
        errorCode: failure.code,
      });
      await this.state.fail(ctx, failure.code);
      return null;
    }
    await this.recordCost(ctx, call.id, result);
    return result;
  }

  /** Chamada de visão: nunca falha a versão; o custo fica gravado mesmo com resposta inválida. */
  async visionCall(
    ctx: TurnContext,
    spec: { model: string; run: () => Promise<VisionAssessment> },
  ): Promise<OptionalCall<VisionAssessment>> {
    const call = this.pending({ kind: 'vision', model: spec.model, size: 'low' });
    const reserved = await this.state.reserveCall(ctx, call, this.maxPaidCalls(), 'skip');
    if (reserved === 'cancelled') return { status: 'over' };
    if (reserved === 'limit') return { status: 'skipped' };
    const assessment = await spec.run();
    await this.closeVision(ctx, call.id, assessment);
    return { status: 'ok', value: assessment };
  }

  private async closeVision(
    ctx: TurnContext,
    callId: string,
    assessment: VisionAssessment,
  ): Promise<void> {
    const outcome: CallOutcome = {
      status: 'done',
      costUsd: assessment.costUsd,
      requestId: assessment.requestId,
    };
    if (assessment.ok === false) {
      outcome.status = 'failed';
      outcome.errorCode = `VISION_${assessment.reason.toUpperCase()}`;
    }
    try {
      await this.state.closeCall(ctx, callId, outcome);
    } catch (error) {
      this.logger.error(
        `Custo da visão não gravado (cena ${ctx.sceneId}, versão ${ctx.versionId}): ${(error as Error).message}`,
      );
    }
  }

  /** O custo da chamada paga fica gravado mesmo que o resto falhe; se nem isso gravar, só registra no log. */
  private async recordCost(
    ctx: TurnContext,
    callId: string,
    result: SceneGenerateResult,
  ): Promise<void> {
    try {
      await this.state.closeCall(ctx, callId, {
        status: 'done',
        costUsd: result.costUsd,
        requestId: result.requestId,
        latencyMs: result.latencyMs,
      });
    } catch (error) {
      this.logger.error(
        `Custo não gravado (cena ${ctx.sceneId}, versão ${ctx.versionId}, custo ${result.costUsd}, requisição ${result.requestId}): ${(error as Error).message}`,
      );
    }
  }

  private logProviderFailure(ctx: TurnContext, failure: SceneProviderError): void {
    const detail = `sceneId=${ctx.sceneId} versionId=${ctx.versionId} correlationId=${ctx.correlationId}`;
    if (failure.code === 'PROVIDER_QUOTA') {
      this.logger.error(
        `Provedor de imagem sem saldo (PROVIDER_QUOTA): ${detail}. Avise o administrador.`,
      );
    } else {
      this.logger.warn(
        `Provedor de imagem falhou (${failure.code}): ${detail}: ${failure.message}`,
      );
    }
  }
}
