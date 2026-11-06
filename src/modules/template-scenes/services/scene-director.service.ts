import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llmCostUsd, llmPricesFor } from '../../ai/openai-llm-pricing';
import { isOpenAiQuotaError } from '../../../shared/providers/openai-errors';
import { DIRECTOR_JSON_SCHEMA } from '../domain/scene-director-schema';
import { DIRECTOR_INSTRUCTIONS } from '../domain/scene-director-prompt';
import {
  DirectorScript,
  SCENE_DIRECTOR_CLIENT,
  SceneDirectorClient,
} from '../providers/scene-director-client';

export const DEFAULT_DIRECTOR_MODEL = 'gpt-6-luna';
/** Tempo máximo do Diretor (D-30: "costuma levar até 10 s"; o teto é o dobro). */
export const DEFAULT_DIRECTOR_TIMEOUT_MS = 20_000;

export type DirectorRun =
  | {
      ok: true;
      text: string;
      /** `null` quando a resposta veio sem `usage`: o consumer marca o custo como desconhecido. */
      costUsd: number | null;
      requestId: string | null;
      latencyMs: number;
    }
  | {
      ok: false;
      /** `unpriced`: modelo pago sem preço conferido, nunca chamado. */
      reason: 'timeout' | 'error' | 'quota' | 'unpriced';
      /** Custo desconhecido: timeout e erro podem ter sido cobrados. */
      costUsd: null;
      requestId: null;
    };

export interface DirectorRunInput {
  /** Mensagem do turno: histórico, pedidos, versões, marcação, camadas e a mensagem atual. */
  text: string;
  /** JPEG da imagem atual; `null` na cena sem imagem. */
  image: Buffer | null;
  script: DirectorScript;
  correlationId: string;
}

const sleepFor = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

/**
 * Chama o Diretor e entrega o resultado sem lançar: falha, quota, tempo esgotado e modelo sem preço viram
 * `ok: false`, e o consumer decide (`DIRECTOR_UNAVAILABLE`). A chamada paga é gravada pelo consumer.
 * Uma só requisição por chamada; refazer a saída inválida é do consumer, que chama de novo com o motivo.
 */
@Injectable()
export class SceneDirectorService {
  private readonly logger = new Logger(SceneDirectorService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(SCENE_DIRECTOR_CLIENT) private readonly client: SceneDirectorClient,
  ) {}

  model(): string {
    return this.config.get<string>('TEMPLATE_SCENE_DIRECTOR_MODEL', DEFAULT_DIRECTOR_MODEL);
  }

  timeoutMs(): number {
    const value = Number(
      this.config.get<string>(
        'TEMPLATE_SCENE_DIRECTOR_TIMEOUT_MS',
        String(DEFAULT_DIRECTOR_TIMEOUT_MS),
      ),
    );
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_DIRECTOR_TIMEOUT_MS;
  }

  async run(input: DirectorRunInput): Promise<DirectorRun> {
    const model = this.model();
    if (!llmPricesFor(model)) {
      this.logger.error(
        `Modelo do Diretor sem preço conferido, não chamado: ${model} (correlationId=${input.correlationId})`,
      );
      return { ok: false, reason: 'unpriced', costUsd: null, requestId: null };
    }
    const timeoutMs = this.timeoutMs();
    try {
      const outcome = await Promise.race([
        this.client.plan({
          model,
          instructions: DIRECTOR_INSTRUCTIONS,
          text: input.text,
          image: input.image,
          jsonSchema: DIRECTOR_JSON_SCHEMA,
          timeoutMs,
          correlationId: input.correlationId,
          script: input.script,
        }),
        sleepFor(timeoutMs),
      ]);
      if (outcome === 'timeout') return this.failure('timeout');
      return {
        ok: true,
        text: outcome.text,
        costUsd: llmCostUsd(model, outcome.usage),
        requestId: outcome.requestId,
        latencyMs: outcome.latencyMs,
      };
    } catch (error) {
      const reason = isOpenAiQuotaError(error) ? 'quota' : 'error';
      this.logger.warn(
        `Diretor falhou (${reason}) (correlationId=${input.correlationId}): ${(error as Error).message}`,
      );
      return this.failure(reason);
    }
  }

  private failure(reason: 'timeout' | 'error' | 'quota'): DirectorRun {
    return { ok: false, reason, costUsd: null, requestId: null };
  }
}
