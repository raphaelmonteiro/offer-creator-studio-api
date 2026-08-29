import {
  McScript,
  McScriptEndcard,
  McScriptScene,
  McScriptSeal,
  McSealProduct,
  MC_MAX_SEAL_PRODUCTS,
} from './mc-types';

/**
 * Diretor multi-cena (plano-comerciais §5.1 etapa 1) — TUDO que dá para
 * decidir sem rede fica aqui, puro e testado: quantas cenas cabem na duração
 * alvo, o system prompt com as regras do produto, o json_schema estrito da
 * resposta, a normalização/validação do que o LLM devolveu e o roteiro mock.
 * O processor só faz o fetch e chama estas funções.
 *
 * Contrato do McScript v2: cada cena tem `actionPrompt` (pt, para a UI),
 * `actionPromptEn` (EN, para os motores), `dialogue` (string|null) e
 * `durationS` (4..12); o roteiro carrega `seal` (produtos do projeto) e
 * `endcard` (estabelecimento do usuário).
 */

export const MC_MAX_SCENES = 8;
export const MC_SCENE_MIN_S = 4;
export const MC_SCENE_MAX_S = 12;

/** Tolerância da soma das durações em relação ao alvo (±20%, contrato v1-B1). */
export const MC_DURATION_TOLERANCE = 0.2;

/** Caracteres falados por segundo — teto de fala que cabe na cena (herdado da v0). */
export const MC_CHARS_PER_SECOND = 15;

export interface SceneCountRange {
  min: number;
  max: number;
}

/**
 * Faixa de cenas por duração alvo (contrato v1-B1):
 * ≤15s → 1–2 · 16–30s → 2–4 · 31–60s → 4–8.
 * Função pura extraída para teste direto (a regra é de produto, não de LLM).
 */
export function sceneCountRange(targetDurationS: number): SceneCountRange {
  if (targetDurationS <= 15) return { min: 1, max: 2 };
  if (targetDurationS <= 30) return { min: 2, max: 4 };
  return { min: 4, max: MC_MAX_SCENES };
}

/** Duração aceitável do roteiro inteiro (alvo ±20%). */
export function durationBounds(targetDurationS: number): { min: number; max: number } {
  return {
    min: Math.round(targetDurationS * (1 - MC_DURATION_TOLERANCE)),
    max: Math.round(targetDurationS * (1 + MC_DURATION_TOLERANCE)),
  };
}

/**
 * System prompt do diretor. Regras do produto (contrato v1-B1):
 * 1 ação física simples por cena · continuidade de cenário entre cenas ·
 * preços SEMPRE por extenso nas falas · cena final pode ser convite/CTA ·
 * produtos do briefing mencionados nas falas · nada de texto escrito na cena
 * (selos e cartela são camada determinística, plano §5.4).
 */
export function buildDirectorSystemPrompt(opts: {
  targetDurationS: number;
  products: McSealProduct[];
}): string {
  const range = sceneCountRange(opts.targetDurationS);
  const bounds = durationBounds(opts.targetDurationS);
  const productList =
    opts.products.length > 0
      ? opts.products.map((p) => `${p.name} (R$ ${p.price})`).join('; ')
      : null;
  const lines = [
    'Você é o diretor de comerciais curtos de supermercado estrelados por um mascote.',
    `Transforme o briefing em um roteiro de ${range.min} a ${range.max} cenas ` +
      `para um vídeo de aproximadamente ${opts.targetDurationS} segundos ` +
      `(a soma das durações precisa ficar entre ${bounds.min} e ${bounds.max} segundos).`,
    '',
    'Regras obrigatórias:',
    `- Cada cena dura de ${MC_SCENE_MIN_S} a ${MC_SCENE_MAX_S} segundos e tem UMA ` +
      'ação física simples do mascote (nada de sequências com vários passos).',
    '- CONTINUIDADE: todas as cenas acontecem no MESMO cenário (ex.: o mesmo corredor ' +
      'de supermercado), com a mesma iluminação — descreva o cenário em todas as cenas.',
    '- "actionPrompt": a ação da cena em pt-BR (1–2 frases, é o que o usuário lê).',
    '- "actionPromptEn": EXATAMENTE a mesma ação em inglês, no imperativo descritivo ' +
      'usado por motores de vídeo (ex.: "The mascot picks up a cereal box and smiles ' +
      'at the camera, same supermarket aisle").',
    '- "dialogue": a fala do mascote em pt-BR de varejo, natural e entusiasmada, ou ' +
      'null quando a cena for muda (pelo menos uma cena deve ter fala).',
    // Achado da 1ª produção real multi-cena: o clipe do motor de fala acompanha
    // a DURAÇÃO DO ÁUDIO, então fala curta = cena curta (um comercial de 30s
    // saiu com 6,5s). Instrução em PALAVRAS + exemplo concreto: contagem de
    // caracteres é justamente o que LLM erra, palavras ele acerta.
    '- REGRA CRÍTICA DE DURAÇÃO: a fala PREENCHE a cena — o vídeo dura o tempo do ' +
      'áudio, então fala curta gera cena curta e o comercial sai truncado. ' +
      'Fale ~2,5 palavras por segundo: cena de 4s ≈ 10 palavras, de 6s ≈ 15 palavras, ' +
      'de 8s ≈ 20 palavras, de 10s ≈ 25 palavras.',
    '- Exemplo de fala BOA para uma cena de 6s (15 palavras): "Olha só que laranja ' +
      'linda, docinha e fresquinha, direto da fazenda pra sua casa hoje!" — ' +
      'exemplo RUIM (curto demais): "Olha as laranjas!".',
    '- Preços SEMPRE por extenso na fala (ex.: "nove e noventa e nove", nunca "9,99" ou "R$ 9,99").',
    '- NADA de texto escrito, placas, etiquetas ou números na descrição da cena: ' +
      'preço, nome do produto e nome da loja entram depois como camada gráfica.',
    '- A última cena pode ser um convite/chamada para ação ("corre pro mercado!").',
    '- Não invente promoções que não estão no briefing.',
  ];
  if (productList) {
    lines.push(
      `- Produtos em oferta (mencione-os nas falas, com o preço por extenso): ${productList}.`,
    );
  }
  return lines.join('\n');
}

/** json_schema ESTRITO da resposta do diretor (OpenAI structured outputs). */
export function buildDirectorJsonSchema(): Record<string, unknown> {
  return {
    name: 'roteiro_comercial',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scenes: {
          type: 'array',
          minItems: 1,
          maxItems: MC_MAX_SCENES,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              actionPrompt: { type: 'string' },
              actionPromptEn: { type: 'string' },
              // strict mode não aceita campo opcional: fala ausente = null.
              dialogue: { type: ['string', 'null'] },
              durationS: { type: 'integer' },
            },
            required: ['actionPrompt', 'actionPromptEn', 'dialogue', 'durationS'],
          },
        },
      },
      required: ['scenes'],
    },
  };
}

export interface RawDirectorScene {
  actionPrompt?: string | null;
  actionPromptEn?: string | null;
  dialogue?: string | null;
  durationS?: number | null;
}

/**
 * Normaliza a saída do LLM em cenas válidas: descarta cenas sem ação, reindexa
 * por posição, limita a `MC_MAX_SCENES`, faz clamp da duração em 4..12s e corta
 * fala que não caberia na cena. Lança quando não sobrou nenhuma cena — falha
 * honesta em vez de roteiro vazio virando projeto quebrado.
 */
export function normalizeDirectorScenes(raw: RawDirectorScene[]): McScriptScene[] {
  const scenes: McScriptScene[] = [];
  for (const item of raw ?? []) {
    if (scenes.length >= MC_MAX_SCENES) break;
    const actionPrompt = (item?.actionPrompt ?? '').trim();
    if (!actionPrompt) continue;
    const durationS = Math.min(
      MC_SCENE_MAX_S,
      Math.max(MC_SCENE_MIN_S, Math.round(Number(item?.durationS) || MC_SCENE_MIN_S)),
    );
    const actionPromptEn = (item?.actionPromptEn ?? '').trim();
    const dialogue = (item?.dialogue ?? '').trim();
    scenes.push({
      idx: scenes.length,
      actionPrompt,
      ...(actionPromptEn ? { actionPromptEn } : {}),
      dialogue: dialogue ? dialogue.slice(0, durationS * MC_CHARS_PER_SECOND + 40) : null,
      durationS,
    });
  }
  if (scenes.length === 0) {
    throw new Error('script_failed: diretor devolveu roteiro sem cenas utilizáveis');
  }
  return scenes;
}

/** Selo do roteiro a partir dos produtos do projeto (null quando não há produtos). */
export function buildScriptSeal(products: McSealProduct[]): McScriptSeal | null {
  const valid = products
    .filter((p) => p?.name?.trim() && p?.price?.trim())
    .slice(0, MC_MAX_SEAL_PRODUCTS)
    .map((p) => ({ name: p.name.trim(), price: p.price.trim() }));
  return valid.length > 0 ? { products: valid } : null;
}

/** Cartela final a partir do estabelecimento do usuário (omitida sem tradeName). */
export function buildEndcard(tradeName: string | null | undefined): McScriptEndcard | null {
  const name = tradeName?.trim();
  return name ? { storeName: name.slice(0, 60) } : null;
}

/**
 * Roteiro MOCK (MC_SCRIPT_PROVIDER=mock): 3 cenas fixas — 2 faladas + 1 muda —
 * exatamente o material do e2e multi-cena de custo zero (exercita keyframe+tts+
 * lipsync nas faladas e keyframe+video na muda, além de concat/selos/legendas).
 */
export function buildMockScript(input: {
  products?: McSealProduct[];
  storeName?: string | null;
}): McScript {
  const seal = buildScriptSeal(input.products ?? []);
  const endcard = buildEndcard(input.storeName);
  return {
    version: 2,
    scenes: [
      {
        idx: 0,
        actionPrompt:
          'O mascote acena para a câmera no corredor do supermercado, ao lado das gôndolas.',
        actionPromptEn:
          'The mascot waves at the camera in a supermarket aisle, standing next to the shelves.',
        dialogue: 'Bem-vindo às ofertas da semana!',
        durationS: 6,
      },
      {
        idx: 1,
        actionPrompt:
          'No mesmo corredor, o mascote pega um produto da prateleira e mostra para a câmera.',
        actionPromptEn:
          'In the same aisle, the mascot picks a product from the shelf and shows it to the camera.',
        dialogue: 'Leve hoje por nove e noventa e nove!',
        durationS: 6,
      },
      {
        idx: 2,
        actionPrompt: 'Ainda no mesmo corredor, o mascote dá um joinha e sorri para a câmera.',
        actionPromptEn:
          'Still in the same aisle, the mascot gives a thumbs up and smiles at the camera.',
        dialogue: null,
        durationS: 4,
      },
    ],
    ...(seal ? { seal } : {}),
    ...(endcard ? { endcard } : {}),
  };
}
