import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { llmCostUsd, llmPricesFor } from '../../ai/openai-llm-pricing';
import { VisionUsage } from '../../ai/openai-vision.service';
import { SCENE_VISION_CLIENT, SceneVisionClient } from '../providers/scene-vision-client';
import { sleepFor } from '../domain/scene-timing';
import { compareReadText, ReadLine, TextLine } from '../domain/scene-text-check';

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
      /** O que o cliente pediu e não aparece, em uma frase nominal em pt-BR (vazia se nada falta). */
      missing: string;
      /** A leitura do texto esperado, já comparada pelo código com a linha pedida; vazia sem texto esperado. */
      textLines: TextLine[];
      /** Texto visível que ninguém pediu (até 120 caracteres); vazio se não houver. */
      extraText: string;
      /** O juiz viu emenda, corte brusco ou objeto flutuando sobre ilha ou faixa (D-44); não muda o veredito. */
      seam: boolean;
      seamDescription: string;
      costUsd: number | null;
      requestId: string | null;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: 'invalid_json' | 'timeout' | 'error' | 'unpriced';
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
  plan: { image?: { change?: string } | null };
  openItems: Array<{ id: string; text: string }>;
  /** Itens dados como feitos antes: o juiz diz se ainda aparecem depois do redesenho. */
  doneItems?: Array<{ id: string; text: string }>;
  /** A cena tinha imagem antes: o juiz recebe ANTES e DEPOIS. Na primeira imagem, só DEPOIS. */
  hasBefore: boolean;
  /** Linhas de texto que devem estar na imagem: as da rodada e as já pintadas e conferidas (D-51, D-56). */
  expectedText?: string[];
  /** O recorte da região do texto vai como imagem a mais. */
  hasCrop?: boolean;
  /** Texto que já estava pintado na imagem e a rodada não pede de novo: não é texto "extra" (D-51, D-56). */
  knownText?: string[];
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Pedido de leitura do texto (D-51): as linhas esperadas e, se houver, a imagem a mais com o recorte da região. */
function textRequest(input: JudgePromptInput): string[] {
  const lines = (input.expectedText ?? []).map((line) => oneLine(line)).filter(Boolean);
  const known = (input.knownText ?? []).map((line) => oneLine(line)).filter(Boolean);
  const knownNote = known.length
    ? [
        `Texto que já estava pintado antes e pode continuar na imagem (não é texto extra): ${known.map((line) => `“${line}”`).join(' / ')}`,
      ]
    : [];
  if (lines.length === 0) return ['Texto esperado na imagem: nenhum.', ...knownNote];
  return [
    ...knownNote,
    `Texto esperado na imagem DEPOIS (transcreva cada linha, sem corrigir):\n${lines.map((line, i) => `Linha ${i + 1}: “${line}”`).join('\n')}`,
    ...(input.hasCrop
      ? ['A última imagem é o recorte da região do texto, na resolução da imagem original.']
      : []),
  ];
}

/**
 * Pedido ao juiz: a imagem inteira antes e depois, a mensagem do cliente, o plano e a lista em aberto. O prompt
 * avisa que o plano pode estar errado (crítica S2): a conferência é contra a mensagem do cliente.
 */
export function buildVisionPrompt(input: JudgePromptInput): string {
  const plan = oneLine(input.plan.image?.change ?? '');
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
    'Ano, data ou número citado na mensagem do cliente é contexto, não pedido de imagem: não cobre como faltando e não diga em "mudou" que o ano ou o número não aparece.',
    ...textRequest(input),
    'Responda só com JSON no formato {"atendeu": "sim"|"parcial"|"nao", "mudou": string, "vistos": string[], "nao_vistos": string[], "faltou": string, "texto_lido": [{"pedido": string, "lido": string}], "texto_extra": string, "emenda": boolean, "emenda_descricao": string}.',
    '"atendeu" diz se a mensagem do cliente foi atendida. "mudou" descreve em uma frase curta, em português, o que mudou em relação ao pedido (e não qualquer diferença). "vistos" lista os ids dos pedidos em aberto cujo RESULTADO você VÊ na imagem DEPOIS (num pedido de tirar algo, o item não aparece mais; num pedido de colocar ou mudar, o resultado aparece), e "nao_vistos" os ids cujo resultado você NÃO vê (por exemplo, o item que devia sair continua lá). "faltou" é uma frase nominal curta em português sobre o que o cliente pediu e não aparece (por exemplo: a frase “Promoção de Páscoa” na placa), até 160 caracteres, vazia se nada falta. "texto_lido" só vale quando há texto esperado (veja acima): para cada linha esperada, "pedido" é a linha como foi pedida e "lido" é o que está ESCRITO na imagem, transcrito caractere por caractere, sem corrigir nada (acentos, cedilha, maiúsculas, vírgulas, R$); se não achar a linha, "lido" fica vazio; sem texto esperado, lista vazia. "texto_extra" é o texto, letras ou números legíveis pintados na imagem DEPOIS que não estão nas linhas esperadas (até 120 caracteres; ano pintado também conta aqui, sem mudar "atendeu"), vazio se não houver. "emenda" é true se a imagem DEPOIS tem emenda, corte brusco ou transição abrupta entre uma parte e outra, ou objeto ou grupo de objetos flutuando, apoiado em ilha, faixa ou pedaço de terreno separado do resto da cena; "emenda_descricao" diz isso em uma frase curta (vazia se "emenda" for false). "emenda" não muda "atendeu". Não afirme nada sobre o resto da imagem.',
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
  missing: string;
  readText: ReadLine[];
  extraText: string;
  seam: boolean;
  seamDescription: string;
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

function readLines(value: unknown): ReadLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines = value.map((entry: unknown) => {
    const row = entry as Record<string, unknown> | null;
    return typeof row?.pedido === 'string' && typeof row.lido === 'string'
      ? { pedido: row.pedido, lido: row.lido }
      : null;
  });
  return lines.every((line): line is ReadLine => line !== null) ? lines : null;
}

function parseAssessment(raw: string, input: JudgePromptInput): Parsed | null {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const satisfied = json.atendeu;
    if (typeof json.mudou !== 'string' || !json.mudou.trim()) return null;
    if (satisfied !== 'sim' && satisfied !== 'parcial' && satisfied !== 'nao') return null;
    if (typeof json.emenda !== 'boolean') return null;
    const readText = readLines(json.texto_lido ?? []);
    // Com texto esperado, a leitura é obrigatória: sem ela o código não tem o que comparar.
    if (!readText || ((input.expectedText?.length ?? 0) > 0 && !Array.isArray(json.texto_lido))) {
      return null;
    }
    const known = new Set([...input.openItems, ...(input.doneItems ?? [])].map((item) => item.id));
    const seen = ids(json.vistos, known);
    return {
      changed: json.mudou.trim().slice(0, 300),
      satisfied,
      seen,
      notSeen: ids(json.nao_vistos, known).filter((id) => !seen.includes(id)),
      missing: text(json.faltou, 160),
      readText,
      extraText: text(json.texto_extra, 120),
      seam: json.emenda,
      seamDescription: text(json.emenda_descricao, 300),
    };
  } catch {
    return null;
  }
}

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
      /** JPEG do recorte da região do texto na resolução da master, quando há texto esperado. */
      crop?: Buffer;
      correlationId: string;
    },
  ): Promise<VisionAssessment> {
    const model = this.model();
    // Modelo pago sem preço conferido não é chamado (R11): o custo seria desconhecido. Recusa antes da rede, custo zero.
    if (!llmPricesFor(model)) {
      this.logger.error(
        `Modelo do juiz sem preço conferido, não chamado: ${model} (correlationId=${input.correlationId})`,
      );
      return { ok: false, reason: 'unpriced', costUsd: 0, requestId: null };
    }
    const timeoutMs = this.timeoutMs();
    try {
      const outcome = await Promise.race([
        this.client.compare({
          model,
          prompt: buildVisionPrompt(input),
          before: input.before,
          after: input.after,
          crop: input.crop,
          timeoutMs,
          correlationId: input.correlationId,
        }),
        sleepFor(timeoutMs),
      ]);
      if (outcome === 'timeout')
        return { ok: false, reason: 'timeout', costUsd: null, requestId: null };
      const costUsd = visionCostUsd(model, outcome.usage);
      const parsed = parseAssessment(outcome.text, input);
      if (!parsed) {
        return { ok: false, reason: 'invalid_json', costUsd, requestId: outcome.requestId };
      }
      const { readText, ...rest } = parsed;
      return {
        ok: true,
        ...rest,
        textLines: compareReadText(input.expectedText ?? [], readText),
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
