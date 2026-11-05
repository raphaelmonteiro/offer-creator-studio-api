import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SceneCallRecord, SceneFailureCode } from '../domain/scene.types';
import {
  SCENE_IMAGE_PROVIDER,
  SceneGenerateResult,
  SceneImageProvider,
  SceneProviderError,
} from '../providers/scene-image-provider';
import { SceneFilesService } from '../services/scene-files.service';
import { buildSceneOutputs, SceneOutputs } from './scene-output';
import { buildGeneratePrompt } from './scene-prompt';
import { SceneTurnState, StoredFile, TurnContext } from './scene-turn-state';

export interface SceneTurnJob {
  sceneId: string;
  versionId: string;
}

const DEFAULT_MODEL = 'gpt-image-2.5-sunburst';
const DEFAULT_QUALITY = 'high';
const DEFAULT_MAX_PAID_CALLS = 4;

/**
 * Consumer de `template_scene.turn` (operação `generate`). Etapas: `preparing`, `generating`,
 * `saving`, `done`. Regras:
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
    private readonly files: SceneFilesService,
    private readonly config: ConfigService,
    @Inject(SCENE_IMAGE_PROVIDER) private readonly provider: SceneImageProvider,
  ) {}

  async process(job: SceneTurnJob, jobId?: string): Promise<void> {
    let ctx: TurnContext | null = null;
    try {
      ctx = await this.state.begin(job.sceneId, job.versionId);
      if (!ctx) {
        this.logger.log(`Job ${jobId ?? '?'} ignorado: versão ${job.versionId} não está pendente`);
        return;
      }
      await this.generate(ctx);
    } catch (error) {
      this.logger.error(
        `Turno da cena ${job.sceneId} falhou (versão ${job.versionId}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (ctx) await this.failSafely(ctx, 'PROVIDER_ERROR');
    }
  }

  private async generate(ctx: TurnContext): Promise<void> {
    if (!(await this.state.advance(ctx, 'generating'))) return;
    const call: SceneCallRecord = {
      id: randomUUID(),
      kind: 'generate',
      status: 'pending',
      model: this.model(),
      size: `${ctx.widthPx}x${ctx.heightPx}`,
      startedAt: new Date().toISOString(),
    };
    if ((await this.state.reserveCall(ctx, call, this.maxPaidCalls())) !== 'ok') return;

    const result = await this.callProvider(ctx, call);
    if (!result) return;
    // Daqui em diante a chamada já foi paga: nada abaixo pode lançar.
    try {
      await this.saveAndFinish(ctx, result);
    } catch (error) {
      this.logger.error(
        `Falha ao salvar a cena ${ctx.sceneId} depois da chamada paga: ${(error as Error).message}`,
      );
      await this.failSafely(ctx, 'PROVIDER_ERROR');
    }
  }

  /** Chama o provedor fora de qualquer lock; falha classificada fecha a tentativa e a versão. */
  private async callProvider(
    ctx: TurnContext,
    call: SceneCallRecord,
  ): Promise<SceneGenerateResult | null> {
    let result: SceneGenerateResult;
    try {
      result = await this.provider.generate({
        model: call.model,
        prompt: buildGeneratePrompt({ ...ctx, request: ctx.request }),
        size: call.size,
        quality: this.config.get<string>('TEMPLATE_SCENE_IMAGE_QUALITY', DEFAULT_QUALITY),
        correlationId: ctx.correlationId,
      });
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

  private async saveAndFinish(ctx: TurnContext, result: SceneGenerateResult): Promise<void> {
    if (await this.state.isCancelRequested(ctx)) {
      await this.state.cancel(ctx);
      return;
    }
    if (!(await this.state.advance(ctx, 'saving'))) return;
    const outputs = await buildSceneOutputs(result.buffer);
    const stored = await this.storeFiles(ctx, outputs);
    const outcome = await this.state.complete(ctx, stored);
    if (outcome !== 'ready') await this.removeFiles([stored.master, stored.preview]);
  }

  private async storeFiles(
    ctx: TurnContext,
    outputs: SceneOutputs,
  ): Promise<{ master: StoredFile; preview: StoredFile }> {
    const write = async (file: SceneOutputs['master']): Promise<StoredFile> => {
      const written = await this.files.write(
        ctx.sceneId,
        ctx.versionId,
        file.filename,
        file.buffer,
      );
      return { url: written.url, bytes: written.bytes, width: file.width, height: file.height };
    };
    return { master: await write(outputs.master), preview: await write(outputs.preview) };
  }

  private async removeFiles(stored: StoredFile[]): Promise<void> {
    await Promise.all(stored.map((file) => this.files.remove(file.url).catch(() => undefined)));
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

  private model(): string {
    return this.config.get<string>('TEMPLATE_SCENE_IMAGE_MODEL', DEFAULT_MODEL);
  }

  private maxPaidCalls(): number {
    const value = Number(
      this.config.get<string>(
        'TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE',
        String(DEFAULT_MAX_PAID_CALLS),
      ),
    );
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_PAID_CALLS;
  }
}
