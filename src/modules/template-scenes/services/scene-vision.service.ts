import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llmCostUsd } from '../../ai/openai-llm-pricing';
import { VisionUsage } from '../../ai/openai-vision.service';
import { SCENE_VISION_CLIENT, SceneVisionClient } from '../providers/scene-vision-client';

export const DEFAULT_VISION_MODEL = 'gpt-6-luna';
/** PV-2: tempo máximo do juiz; passou disso, a resposta diz que não conseguiu conferir. */
export const DEFAULT_VISION_TIMEOUT_MS = 20_000;

export type VisionSatisfied = 'sim' | 'parcial' | 'nao';

export type VisionAssessment =
  | {
      ok: true;
      changed: string;
      satisfied: VisionSatisfied;
      /** Ids da lista do que o cliente pediu que o juiz viu na imagem nova. */
      seen: string[];
      /** Ids que o juiz não viu. */
      notSeen: string[];
      /** O juiz viu texto legível pintado na imagem nova. */
      textInImage: boolean;
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
 * Custo da chamada do juiz (e do Diretor): o cálculo é o mesmo, com cache de entrada e escrita em cache
 * (`openai-llm-pricing.ts`). O juiz não muda de preço com o `detail`, só de tokens. Modelo sem preço conferido
 * ou sem `usage`: `null`.
 */
export function visionCostUsd(model: string, usage: VisionUsage | null): number | null {
  return llmCostUsd(model, usage);
}

/** O que o juiz recebe além das imagens: a mensagem, o plano e o que o cliente pediu e ainda não apareceu. */
export interface JudgePromptInput {
  message: string;
  plan: { what_to_change?: string; what_to_put?: string };
  openItems: Array<{ id: string; text: string }>;
  /** Itens dados como feitos antes: o juiz diz se ainda aparecem depois do redesenho. */
  doneItems?: Array<{ id: string; text: string }>;
  /** A cena tinha imagem antes: o juiz recebe ANTES e DEPOIS. Na primeira imagem, só DEPOIS. */
  hasBefore: boolean;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Pedido ao juiz: a imagem inteira antes e depois, a mensagem do cliente, o plano e a lista em aberto. O prompt
 * avisa que o plano pode estar errado (crítica S2): a conferência é contra a mensagem do cliente.
 */
export function buildVisionPrompt(input: JudgePromptInput): string {
  const plan = [input.plan.what_to_change, input.plan.what_to_put]
    .map((part) => oneLine(part ?? ''))
    .filter(Boolean)
    .join('; ');
  const list = (items: Array<{ id: string; text: string }>): string =>
    items.map((item) => `- ${item.id}: ${oneLine(item.text)}`).join('\n');
  const items = input.openItems.length ? list(input.openItems) : 'nenhum';
  const done = input.doneItems?.length
    ? `\nPedidos que já pareciam atendidos (id: texto); diga em "vistos" ou "nao_vistos" se o resultado ainda aparece na imagem DEPOIS:\n${list(input.doneItems)}`
    : '';
  return [
    input.hasBefore
      ? 'Você confere o resultado de uma edição de imagem de encarte: a primeira imagem é ANTES e a segunda é DEPOIS.'
      : 'Você confere uma imagem de encarte recém-criada: só há a imagem DEPOIS.',
    `Mensagem do cliente: "${oneLine(input.message)}".`,
    `Plano do sistema (pode estar errado: confira contra a MENSAGEM DO CLIENTE, não contra o plano): ${plan || 'sem plano'}.`,
    `Pedidos do cliente ainda em aberto (id: texto):\n${items}${done}`,
    'Responda só com JSON no formato {"atendeu": "sim"|"parcial"|"nao", "mudou": string, "vistos": string[], "nao_vistos": string[], "texto_na_imagem": boolean}.',
    '"atendeu" diz se a mensagem do cliente foi atendida. "mudou" descreve em uma frase curta, em português, o que mudou em relação ao pedido (e não qualquer diferença). "vistos" lista os ids dos pedidos em aberto cujo RESULTADO você VÊ na imagem DEPOIS (num pedido de tirar algo, o item não aparece mais; num pedido de colocar ou mudar, o resultado aparece), e "nao_vistos" os ids cujo resultado você NÃO vê (por exemplo, o item que devia sair continua lá). "texto_na_imagem" é true se há texto, letras ou números legíveis pintados na imagem DEPOIS. Não afirme nada sobre o resto da imagem.',
  ].join('\n');
}

const ids = (value: unknown, known: Set<string>): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && known.has(id)))]
    : [];

interface Parsed {
  changed: string;
  satisfied: VisionSatisfied;
  seen: string[];
  notSeen: string[];
  textInImage: boolean;
}

function parseAssessment(text: string, openIds: string[]): Parsed | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const satisfied = json.atendeu;
    if (typeof json.mudou !== 'string' || !json.mudou.trim()) return null;
    if (satisfied !== 'sim' && satisfied !== 'parcial' && satisfied !== 'nao') return null;
    if (typeof json.texto_na_imagem !== 'boolean') return null;
    const known = new Set(openIds);
    const seen = ids(json.vistos, known);
    return {
      changed: json.mudou.trim().slice(0, 300),
      satisfied,
      seen,
      notSeen: ids(json.nao_vistos, known).filter((id) => !seen.includes(id)),
      textInImage: json.texto_na_imagem,
    };
  } catch {
    return null;
  }
}

const sleepFor = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

/**
 * O juiz depois de cada imagem (`gpt-6-luna`, `detail: high`): compara antes e depois inteiros com a mensagem do
 * cliente, o plano e os itens em aberto. Nunca lança: falha, JSON fora do esquema ou passar do tempo viram
 * `ok: false`, e a resposta diz que não conseguiu conferir. O resultado vale em todos os casos (D-26). A chamada é
 * gravada e contada pelo processor (custo por etapa).
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

  async assess(
    input: JudgePromptInput & {
      /** JPEG da imagem inteira antes (ausente na primeira imagem). */
      before?: Buffer;
      /** JPEG da imagem inteira depois. */
      after: Buffer;
      correlationId: string;
    },
  ): Promise<VisionAssessment> {
    const model = this.model();
    const timeoutMs = this.timeoutMs();
    try {
      const outcome = await Promise.race([
        this.client.compare({
          model,
          prompt: buildVisionPrompt(input),
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
      const parsed = parseAssessment(
        outcome.text,
        [...input.openItems, ...(input.doneItems ?? [])].map((item) => item.id),
      );
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
        `Juiz falhou (correlationId=${input.correlationId}): ${(error as Error).message}`,
      );
      return { ok: false, reason: 'error', costUsd: null, requestId: null };
    }
  }
}
