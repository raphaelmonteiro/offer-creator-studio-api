import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SceneCallRecord, SceneFailureCode } from '../domain/scene.types';
import { SceneGenerateResult, SceneProviderError } from '../providers/scene-image-provider';
import { VisionAssessment } from '../services/scene-vision.service';
import { CallOutcome, SceneTurnState, TurnContext } from './scene-turn-state';

const DEFAULT_MAX_PAID_CALLS = 4;

/** O que uma chamada de imagem precisa para ser reservada, executada e gravada. */
export interface ImageCallSpec {
  kind: Extract<SceneCallRecord['kind'], 'generate' | 'edit'>;
  model: string;
  size: string;
  run: () => Promise<SceneGenerateResult>;
}

/** A segunda chamada de imagem falhou no provedor: a versão não falha, e o custo fica registrado (rodada 6). */
export interface FailedRetry {
  failed: { code: SceneFailureCode; costUsd: number | null };
}

/** O que a refação devolve: a imagem, "sem vaga", "o provedor falhou" ou "o turno acabou" (`null`). */
export type RetryResult = SceneGenerateResult | FailedRetry | 'limit' | null;

/** Resultado de uma chamada opcional: valor, "pulada pelo limite" ou "o turno acabou". */
export type OptionalCall<T> =
  | { status: 'ok'; value: T }
  | { status: 'skipped' }
  | { status: 'over' };

/** O que toda chamada de visão devolve ao runner: o custo conhecido e, se falhou, o motivo (`VisionAssessment` e a leitura da referência). */
export interface VisionOutcome {
  ok: boolean;
  reason?: string;
  costUsd: number | null;
  requestId: string | null;
}

/**
 * Executa as chamadas pagas do turno com as garantias do estágio 3 (R10) e do disjuntor:
 * - a tentativa é gravada ANTES da chamada e fechada depois com o custo (`usage`), por etapa;
 * - uma chamada de imagem barrada pelo limite falha a versão com `PAID_CALL_LIMIT`;
 * - o juiz é opcional: se passar do limite, é pulado e a imagem vale (D-26);
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
    const result = await this.runImageCall(ctx, spec, 'first');
    return result === null || result === 'limit' || 'failed' in result ? null : result;
  }

  /**
   * A segunda chamada de imagem da refação do texto (D-51). No limite de chamadas pagas do pedido, devolve `'limit'`
   * sem falhar a versão: a primeira imagem vale, e o chat diz que não refez. Se o provedor falha, devolve `failed`
   * com o custo, também sem falhar a versão (rodada 6): a primeira imagem, já paga, vale. `null` = o turno acabou.
   */
  retryImageCall(ctx: TurnContext, spec: ImageCallSpec): Promise<RetryResult> {
    return this.runImageCall(ctx, spec, 'retry');
  }

  private async runImageCall(
    ctx: TurnContext,
    spec: ImageCallSpec,
    mode: 'first' | 'retry',
  ): Promise<RetryResult> {
    const call = this.pending(spec);
    const onLimit = mode === 'first' ? 'fail' : 'skip';
    const reserved = await this.state.reserveCall(ctx, call, this.maxPaidCalls(), onLimit);
    if (reserved === 'limit') return 'limit';
    if (reserved !== 'ok') return null;
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
        costUsd: failure.costUsd,
        errorCode: failure.code,
      });
      if (mode === 'retry')
        return { failed: { code: failure.code, costUsd: failure.costUsd ?? null } };
      await this.state.fail(ctx, failure.code);
      return null;
    }
    if (result.costUsd === null) this.logUnknownCost(ctx, result);
    await this.recordCost(ctx, call.id, result);
    return result;
  }

  /** Chamada de visão: nunca falha a versão; o custo fica gravado mesmo com resposta inválida. */
  async visionCall<T extends VisionOutcome = VisionAssessment>(
    ctx: TurnContext,
    spec: { model: string; run: () => Promise<T> },
  ): Promise<OptionalCall<T>> {
    const call = this.pending({ kind: 'vision', model: spec.model, size: 'high' });
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
    assessment: VisionOutcome,
  ): Promise<void> {
    const outcome: CallOutcome = {
      status: 'done',
      costUsd: assessment.costUsd,
      requestId: assessment.requestId,
    };
    if (assessment.ok === false) {
      outcome.status = 'failed';
      outcome.errorCode = `VISION_${(assessment.reason ?? 'error').toUpperCase()}`;
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

  /** Resposta paga sem `usage` (ou sem preço): o turno segue com `metrics.costUnknown` e erro no log. */
  private logUnknownCost(ctx: TurnContext, result: SceneGenerateResult): void {
    this.logger.error(
      `Custo desconhecido (resposta sem usage): sceneId=${ctx.sceneId} versionId=${ctx.versionId} requisição=${result.requestId}`,
    );
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
