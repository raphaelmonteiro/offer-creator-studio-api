import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llmPricesFor } from '../../ai/openai-llm-pricing';
import { SCENE_VISION_CLIENT, SceneVisionClient } from '../providers/scene-vision-client';
import { DEFAULT_VISION_MODEL, visionCostUsd } from './scene-vision.service';

/** Tempo máximo da leitura do encarte (a chamada leva cerca de 3 s). */
const READ_TIMEOUT_MS = 60_000;

/** A chamada contra o relógio; o timer sai quando a chamada termina (nada fica pendurado no processo). */
async function withTimeout<T>(call: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([call, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A leitura da visão: o JSON cru com o custo, ou o motivo da falha com o custo conhecido. */
export type ReferenceReading =
  | { ok: true; raw: unknown; costUsd: number | null; requestId: string | null }
  | {
      ok: false;
      reason: 'invalid_json' | 'timeout' | 'error' | 'unpriced';
      costUsd: number | null;
      requestId: string | null;
    };

/**
 * A chamada de visão que lê o encarte de referência e devolve a ficha crua (PV-R10: reaproveita `compare` do cliente
 * de visão, só com `after`). Nunca lança: falha, saída que não é JSON e tempo esgotado viram `ok: false`, com o custo
 * conhecido. Quem grava a chamada e o custo é o `SceneCallRunner`.
 */
@Injectable()
export class SceneReferenceVisionService {
  private readonly logger = new Logger(SceneReferenceVisionService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(SCENE_VISION_CLIENT) private readonly client: SceneVisionClient,
  ) {}

  model(): string {
    return this.config.get<string>('TEMPLATE_SCENE_REFERENCE_MODEL', DEFAULT_VISION_MODEL);
  }

  async read(input: {
    prompt: string;
    image: Buffer;
    correlationId: string;
  }): Promise<ReferenceReading> {
    const model = this.model();
    // Modelo pago sem preço conferido não é chamado (R11): o custo seria desconhecido.
    if (!llmPricesFor(model)) {
      this.logger.error(`Modelo da ficha sem preço conferido, não chamado: ${model}`);
      return { ok: false, reason: 'unpriced', costUsd: 0, requestId: null };
    }
    try {
      const outcome = await withTimeout(
        this.client.compare({
          model,
          prompt: input.prompt,
          after: input.image,
          timeoutMs: READ_TIMEOUT_MS,
          correlationId: input.correlationId,
        }),
        READ_TIMEOUT_MS,
      );
      if (outcome === 'timeout') {
        return { ok: false, reason: 'timeout', costUsd: null, requestId: null };
      }
      const costUsd = visionCostUsd(model, outcome.usage);
      try {
        return { ok: true, raw: JSON.parse(outcome.text), costUsd, requestId: outcome.requestId };
      } catch {
        return { ok: false, reason: 'invalid_json', costUsd, requestId: outcome.requestId };
      }
    } catch (error) {
      this.logger.warn(
        `Leitura do encarte falhou (correlationId=${input.correlationId}): ${(error as Error).message}`,
      );
      return { ok: false, reason: 'error', costUsd: null, requestId: null };
    }
  }
}
