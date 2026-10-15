import type {
  GeminiBilledFailure,
  GeminiUsage,
} from '../../../shared/providers/gemini-image.provider';

/**
 * Custo de FORNECEDOR do kit do personagem (change video-formatos-personagem,
 * tarefa 2.6: "geração real de kit com custo registrado"). Parte PURA: tabela
 * de tarifas por modelo, leitura do uso de tokens de cada fornecedor e o
 * cálculo por chamada. O registro (evento `provider_cost` + soma em
 * `mc_character_kits.providerCostUsd`) fica em services/mc-kit-costs.ts.
 *
 * Fórmula por chamada (US$):
 *   imagens × usdPorImagem + tokensDeEntrada × entrada/1M + tokensDeSaída × saída/1M
 * onde "saída" é texto + raciocínio; a saída de IMAGEM é cobrada só pelo preço
 * por imagem (o Gemini cobra a imagem gerada pelo tamanho, não por token de
 * texto). Na OpenAI, entrada = `usage.prompt_tokens` (inclui a imagem enviada
 * à visão) e saída = `usage.completion_tokens`; tokens em cache são cobrados
 * pela tarifa cheia de entrada (estimativa conservadora).
 */

/** Chamadas pagas do fluxo do kit (uma linha de custo por chamada). */
export const MC_KIT_COST_CALLS = [
  'canonical_desc',
  'reference',
  'mouth_gate',
  'candidate',
  'mouth_variant',
  'adjustments_translation',
  'sheet_translation',
] as const;
export type McKitCostCall = (typeof MC_KIT_COST_CALLS)[number];

/** Tarifa de um modelo: preço por imagem gerada e por milhão de tokens de entrada/saída (US$). */
export interface McModelPrice {
  model: string;
  usdPerImage: number;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

/** Uso cobrável de UMA chamada, já normalizado entre fornecedores. */
export interface McCallUsage {
  inputTokens: number;
  /** Texto + raciocínio (sem a saída de imagem). */
  outputTokens: number;
  /** Imagens geradas (cobradas por `usdPerImage`). */
  images: number;
}

/** Motivo de uma chamada paga sem resultado (ver `McKitProviderCost.failure`). */
export type McKitCostFailure = 'no_output' | 'timed_out' | 'network';

/** Valores aceitos ao reler `failure` de um evento `provider_cost`. */
export const MC_KIT_COST_FAILURES: readonly McKitCostFailure[] = [
  'no_output',
  'timed_out',
  'network',
];

/** Linha de custo de UMA chamada paga (evento `provider_cost` e metadata do asset). */
export interface McKitProviderCost {
  call: McKitCostCall;
  provider: 'openai' | 'gemini';
  /** Modelo que efetivamente respondeu (chave da tarifa). */
  model: string;
  usage: McCallUsage | null;
  /** US$ da chamada; null = modelo fora da tabela ou uso desconhecido (não entra na soma do kit). */
  costUsd: number | null;
  /** Tarifa aplicada (auditoria: a tabela pode mudar depois). */
  rate: McModelPrice | null;
  /**
   * Chamada paga SEM resultado: `no_output` = resposta 200 sem imagem/texto
   * (recusa de segurança, saída vazia — tokens do `usageMetadata`);
   * `timed_out` = abortada no timeout do cliente (a Gemini pode ter gerado);
   * `network` = resposta perdida por falha de rede DEPOIS do envio (idem).
   * Ausente = chamada que entregou o resultado.
   */
  failure?: McKitCostFailure;
  /** Custo estimado, não medido (timeout/rede: preço cheio das imagens pedidas, tokens desconhecidos). */
  estimated?: boolean;
}

/** Variável de ambiente da tabela (formato em `parseModelPrices`). */
export const MC_KIT_PRICES_ENV = 'MC_KIT_PRICES';

/**
 * Tabela padrão (mesmos valores do .env.example):
 * - imagens: US$ por imagem do design.md (D4/Context: Nano Banana Pro 0,134;
 *   Nano Banana 2.1 0,034). Tokens das imagens: tarifa pública do Gemini 3 Pro
 *   Image (entrada US$ 2/1M, texto e raciocínio US$ 12/1M); a 2.1 não tem
 *   tarifa de tokens no design e usa a da Pro como teto (conservador).
 * - gpt-4o e gpt-4o-mini: mesma tabela do repositório
 *   (modules/ai/ean/ean-judge.service.ts, PRICES) — US$ 2,5/10 e 0,15/0,6 por 1M.
 * - gemini-3.8-flash (visão do gate de boca): sem tarifa no design; valor de
 *   referência do Gemini 3 Flash (US$ 0,50 entrada, 3 saída por 1M) até a
 *   tarifa do 3.8 ser confirmada — ajuste por `MC_KIT_PRICES`.
 */
export const MC_MODEL_PRICE_DEFAULTS: readonly McModelPrice[] = [
  { model: 'nano-banana-pro-preview', usdPerImage: 0.134, inputUsdPer1M: 2, outputUsdPer1M: 12 },
  { model: 'gemini-3-pro-image-preview', usdPerImage: 0.134, inputUsdPer1M: 2, outputUsdPer1M: 12 },
  { model: 'gemini-nano-banana-2.1', usdPerImage: 0.034, inputUsdPer1M: 2, outputUsdPer1M: 12 },
  { model: 'gpt-4o', usdPerImage: 0, inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { model: 'gpt-4o-mini', usdPerImage: 0, inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  { model: 'gemini-3.8-flash', usdPerImage: 0, inputUsdPer1M: 0.5, outputUsdPer1M: 3 },
];

/**
 * `MC_KIT_PRICES` = entradas separadas por vírgula, cada uma
 * `modelo|usdPorImagem|usdPor1MEntrada|usdPor1MSaida` (mesmo estilo de
 * `MC_TALK_ENGINE_*`). A entrada substitui a do mesmo modelo na tabela padrão
 * ou acrescenta um modelo novo. Campo vazio = valor padrão do mesmo modelo;
 * modelo fora da tabela padrão precisa dos três números. Mal formado (modelo em
 * branco, número negativo ou NaN, campo faltando) é erro de configuração —
 * derruba o boot (CommercialsModule.onModuleInit), nunca uma tarifa silenciosa.
 */
export function parseModelPrices(
  raw: string | undefined,
  defaults: readonly McModelPrice[] = MC_MODEL_PRICE_DEFAULTS,
  label = MC_KIT_PRICES_ENV,
): McModelPrice[] {
  const table = new Map(defaults.map((p) => [p.model, { ...p }]));
  const text = (raw ?? '').trim();
  if (!text) return [...table.values()];
  for (const entry of text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)) {
    const [modelRaw, ...fields] = entry.split('|').map((t) => t.trim());
    const model = modelRaw ?? '';
    if (!model) throw new Error(`${label}: modelo em branco em "${entry}"`);
    if (fields.length > 3) throw new Error(`${label}: campos demais em "${entry}"`);
    const base = table.get(model);
    const keys = ['usdPerImage', 'inputUsdPer1M', 'outputUsdPer1M'] as const;
    const price: McModelPrice = { model, usdPerImage: 0, inputUsdPer1M: 0, outputUsdPer1M: 0 };
    keys.forEach((key, index) => {
      const value = fields[index];
      if (value === undefined || value === '') {
        if (!base) {
          throw new Error(
            `${label}: "${model}" não está na tabela padrão — informe ` +
              'usdPorImagem|usdPor1MEntrada|usdPor1MSaida',
          );
        }
        price[key] = base[key];
        return;
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${label}: tarifa inválida "${value}" em "${entry}" (número ≥ 0)`);
      }
      price[key] = n;
    });
    table.set(model, price);
  }
  return [...table.values()];
}

/** Tabela vigente (lida do env a cada chamada: barato e testável, como `mcTalkEngines`). */
export function mcModelPrices(env: NodeJS.ProcessEnv = process.env): McModelPrice[] {
  return parseModelPrices(env[MC_KIT_PRICES_ENV]);
}

/**
 * Tarifa do modelo: nome exato; senão o MAIOR prefixo da tabela (a OpenAI
 * responde com o snapshot datado, ex.: `gpt-4o-2024-08-06` → `gpt-4o`, e
 * `gpt-4o-mini-…` casa com `gpt-4o-mini`, não com `gpt-4o`). null = fora da tabela.
 */
export function findModelPrice(
  model: string | null | undefined,
  prices: readonly McModelPrice[],
): McModelPrice | null {
  const name = (model ?? '').trim();
  if (!name) return null;
  const exact = prices.find((p) => p.model === name);
  if (exact) return exact;
  const prefixed = prices
    .filter((p) => name.startsWith(`${p.model}-`))
    .sort((a, b) => b.model.length - a.model.length);
  return prefixed[0] ?? null;
}

/** US$ de um uso numa tarifa, arredondado a 6 casas (a coluna do kit é numeric(12,6)). */
export function priceUsage(usage: McCallUsage, price: McModelPrice): number {
  const usd =
    usage.images * price.usdPerImage +
    (usage.inputTokens * price.inputUsdPer1M) / 1_000_000 +
    (usage.outputTokens * price.outputUsdPer1M) / 1_000_000;
  return Number(usd.toFixed(6));
}

/** `usage` da OpenAI (chat.completions) → uso cobrável; null sem `usage` na resposta. */
export function openAiUsage(
  usage: { prompt_tokens?: number | null; completion_tokens?: number | null } | null | undefined,
): McCallUsage | null {
  if (!usage) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    inputTokens: n(usage.prompt_tokens),
    outputTokens: n(usage.completion_tokens),
    images: 0,
  };
}

/**
 * Uso do Gemini → uso cobrável. `images` = imagens efetivamente devolvidas
 * (1 numa geração, 0 na visão). Sem `usageMetadata`, uma geração ainda cobra a
 * imagem (tokens 0); uma visão sem uso fica desconhecida (null). A saída de
 * texto de uma geração é o total de candidatos menos a parte IMAGE (quando o
 * Gemini não detalha por modalidade, a saída de uma geração é tratada como
 * toda imagem — já coberta pelo preço por imagem).
 */
export function geminiUsage(
  usage: GeminiUsage | null | undefined,
  images: number,
): McCallUsage | null {
  if (!usage) return images > 0 ? { inputTokens: 0, outputTokens: 0, images } : null;
  const imageTokens = usage.outputImageTokens ?? (images > 0 ? usage.candidatesTokens : 0);
  const textTokens = Math.max(0, usage.candidatesTokens - imageTokens);
  return {
    inputTokens: usage.promptTokens,
    outputTokens: textTokens + usage.thoughtsTokens,
    images,
  };
}

/** Linha de custo de uma chamada: tarifa do modelo efetivo × uso; sem tarifa ou sem uso → `costUsd: null`. */
export function kitProviderCost(
  input: {
    call: McKitCostCall;
    provider: McKitProviderCost['provider'];
    model: string;
    usage: McCallUsage | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): McKitProviderCost {
  const rate = findModelPrice(input.model, mcModelPrices(env));
  return {
    call: input.call,
    provider: input.provider,
    model: input.model,
    usage: input.usage,
    costUsd: rate && input.usage ? priceUsage(input.usage, rate) : null,
    rate,
  };
}

/**
 * Linha de custo de uma chamada Gemini cobrada que falhou
 * (`geminiBilledFailure(err)`): resposta sem resultado pelo uso devolvido
 * (sem imagem); timeout e falha de rede depois do envio como ESTIMATIVA pelo
 * teto — o preço das imagens pedidas (`expectedImages`), já que a Gemini pode
 * ter gerado e cobrado.
 */
export function kitFailedCallCost(
  input: { call: McKitCostCall; billing: GeminiBilledFailure; expectedImages: number },
  env: NodeJS.ProcessEnv = process.env,
): McKitProviderCost {
  const { call, billing, expectedImages } = input;
  if (billing.timedOut || billing.networkFailure) {
    return {
      ...kitProviderCost(
        {
          call,
          provider: 'gemini',
          model: billing.model,
          usage: { inputTokens: 0, outputTokens: 0, images: expectedImages },
        },
        env,
      ),
      failure: billing.timedOut ? 'timed_out' : 'network',
      estimated: true,
    };
  }
  return {
    ...kitProviderCost(
      { call, provider: 'gemini', model: billing.model, usage: geminiUsage(billing.usage, 0) },
      env,
    ),
    failure: 'no_output',
  };
}

/** Soma das linhas com custo conhecido (as `null` ficam de fora), 6 casas. */
export function sumKitCosts(entries: ReadonlyArray<Pick<McKitProviderCost, 'costUsd'>>): number {
  const total = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  return Number(total.toFixed(6));
}
