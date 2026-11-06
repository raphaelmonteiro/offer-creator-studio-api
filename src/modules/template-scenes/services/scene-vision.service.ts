import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SCENE_VISION_CLIENT, SceneVisionClient } from '../providers/scene-vision-client';
import { llmCostUsd } from '../../ai/openai-llm-pricing';
import { VisionUsage } from '../../ai/openai-vision.service';

export const DEFAULT_VISION_MODEL = 'gpt-6-luna';
/** PV-2: tempo máximo da visão; passou disso, a resposta sai das métricas. */
export const DEFAULT_VISION_TIMEOUT_MS = 20_000;

export type VisionSatisfied = 'sim' | 'parcial' | 'nao';

export type VisionAssessment =
  | {
      ok: true;
      changed: string;
      satisfied: VisionSatisfied;
      costUsd: number | null;
      requestId: string | null;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: 'invalid_json' | 'timeout' | 'error';
      /** Custo conhecido da chamada que falhou (JSON inválido foi cobrado; timeout e erro, desconhecido). */
      costUsd: number | null;
      requestId: string | null;
    };

/**
 * Custo da chamada de visão (e do Diretor): o cálculo é o mesmo, com cache de entrada e escrita em cache
 * (`openai-llm-pricing.ts`). Modelo sem preço conferido ou sem `usage`: `null`.
 */
export function visionCostUsd(model: string, usage: VisionUsage | null): number | null {
  return llmCostUsd(model, usage);
}

/** Pedido ao modelo de visão: duas imagens (recorte antes e depois) e o pedido do cliente. */
export function buildVisionPrompt(request: string): string {
  const literal = request.replace(/\s+/g, ' ').trim();
  return (
    'Você compara duas imagens de um recorte de cena: a primeira é ANTES, a segunda é DEPOIS de uma edição pedida pelo cliente. ' +
    `Pedido: "${literal}". ` +
    'Você só vê este recorte: não afirme nada sobre o resto da imagem. ' +
    'Responda só com JSON no formato {"mudou": string, "atendeu": "sim"|"parcial"|"nao"}, ' +
    'onde "mudou" descreve em uma frase curta, em português, o que mudou em relação ao pedido (e não qualquer diferença), e "atendeu" diz se o pedido foi atendido.'
  );
}

function parseAssessment(text: string): { changed: string; satisfied: VisionSatisfied } | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const satisfied = json.atendeu;
    if (typeof json.mudou !== 'string' || !json.mudou.trim()) return null;
    if (satisfied !== 'sim' && satisfied !== 'parcial' && satisfied !== 'nao') return null;
    return { changed: json.mudou.trim().slice(0, 300), satisfied };
  } catch {
    return null;
  }
}

const sleepFor = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

/**
 * Resposta da edição por visão antes/depois (`gpt-6-luna`, `reasoning_effort: low`, `detail: low`).
 * Nunca lança: falha, JSON fora do esquema ou passar do tempo viram `ok: false`, e a edição vale com a
 * resposta feita das métricas. A chamada é gravada e contada pelo processor (custo por etapa).
 */
@Injectable()
export class SceneVisionService {
  private readonly logger = new Logger(SceneVisionService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(SCENE_VISION_CLIENT) private readonly client: SceneVisionClient,
  ) {}

  model(): string {
    return this.config.get<string>('TEMPLATE_SCENE_VISION_MODEL', DEFAULT_VISION_MODEL);
  }

  private timeoutMs(): number {
    const value = Number(
      this.config.get<string>(
        'TEMPLATE_SCENE_VISION_TIMEOUT_MS',
        String(DEFAULT_VISION_TIMEOUT_MS),
      ),
    );
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_VISION_TIMEOUT_MS;
  }

  async assess(input: {
    request: string;
    before: Buffer;
    after: Buffer;
    correlationId: string;
  }): Promise<VisionAssessment> {
    const model = this.model();
    const timeoutMs = this.timeoutMs();
    try {
      const outcome = await Promise.race([
        this.client.compare({
          model,
          prompt: buildVisionPrompt(input.request),
          before: input.before,
          after: input.after,
          timeoutMs,
          correlationId: input.correlationId,
        }),
        sleepFor(timeoutMs),
      ]);
      if (outcome === 'timeout')
        return { ok: false, reason: 'timeout', costUsd: null, requestId: null };
      const costUsd = visionCostUsd(model, outcome.usage);
      const parsed = parseAssessment(outcome.text);
      if (!parsed) {
        return { ok: false, reason: 'invalid_json', costUsd, requestId: outcome.requestId };
      }
      return {
        ok: true,
        ...parsed,
        costUsd,
        requestId: outcome.requestId,
        latencyMs: outcome.latencyMs,
      };
    } catch (error) {
      this.logger.warn(
        `Visão falhou (correlationId=${input.correlationId}): ${(error as Error).message}`,
      );
      return { ok: false, reason: 'error', costUsd: null, requestId: null };
    }
  }
}
