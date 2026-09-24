import { MC_SCRIPT_SCHEMA_V2 } from './mc-quality';
import { defaultSealCue, sceneSourceHash } from './mc-script-v2';
import {
  McScript,
  McScriptEndcard,
  McScriptScene,
  McScriptSeal,
  McSceneType,
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

// ─────────────────────────────── pipeline v2 ───────────────────────────────

/**
 * System prompt do diretor V2 (ADR-001 §3.1/§3.2): tipo de cena explícito,
 * ESTADO INICIAL separado do MOVIMENTO, uma ação principal por cena, produto
 * anunciado por cena (índice no snapshot ou null) e derivação EN de ambos os
 * textos. `action_voiceover` não deve pedir que o personagem fale visivelmente.
 */
export function buildDirectorSystemPromptV2(opts: {
  targetDurationS: number;
  products: McSealProduct[];
}): string {
  const range = sceneCountRange(opts.targetDurationS);
  const bounds = durationBounds(opts.targetDurationS);
  const productList =
    opts.products.length > 0
      ? opts.products
          .map((p, i) => `[${i}] ${p.name} (R$ ${p.price}${p.unit ? ` / ${p.unit}` : ''})`)
          .join('; ')
      : null;
  const lines = [
    'Você é o diretor de comerciais curtos de supermercado estrelados por um mascote.',
    `Transforme o briefing em um roteiro de ${range.min} a ${range.max} cenas ` +
      `para um vídeo de aproximadamente ${opts.targetDurationS} segundos ` +
      `(a soma das durações precisa ficar entre ${bounds.min} e ${bounds.max} segundos).`,
    '',
    'Cada cena tem um TIPO que define como será produzida:',
    '- "presenter": o mascote FALA EM CENA com a boca sincronizada, de frente para a câmera, ' +
      'e pode fazer UMA ação simples enquanto fala (pegar o produto da prateleira, mostrar o pacote, ' +
      'apontar, dar um joinha). É o tipo padrão sempre que o mascote fala olhando para a câmera.',
    '- "action": UMA ação física simples, sem locução (dialogue = null).',
    '- "action_voiceover": use SOMENTE quando o mascote NÃO é o narrador visível — close no ' +
      'produto, mascote de costas ou andando pelo corredor, plano sem o rosto. A voz é narração ' +
      'em off; o personagem não deve aparecer falando.',
    '',
    'Regras obrigatórias:',
    `- Cada cena dura de ${MC_SCENE_MIN_S} a ${MC_SCENE_MAX_S} segundos.`,
    '- "initialFrame": o ESTADO INICIAL da imagem em pt-BR (onde está o mascote, objetos, ' +
      'enquadramento) — NUNCA a sequência inteira. Ex.: "Caixa de arroz na prateleira, mão do mascote próxima".',
    '- "actionPrompt": o MOVIMENTO em pt-BR — uma ação contínua e simples. Ex.: "Pega a caixa e apresenta para a câmera".',
    '- CENA DE PRODUTO: o quadro inicial tem o produto NA PRATELEIRA e o mascote de MÃOS LIVRES; ' +
      'o movimento é pegar o produto e mostrar para a câmera. Nunca comece com o produto já na mão.',
    '- FUNDO LIMPO: corredor com prateleiras de embalagens simples, SEM placas, cartazes, banners, ' +
      'etiquetas de preço ou qualquer texto no cenário (o gerador de vídeo inventa letreiros a partir disso).',
    '- "initialFrameEn" e "actionPromptEn": EXATAMENTE os mesmos textos em inglês, no estilo ' +
      'descritivo usado por geradores de imagem/vídeo.',
    '- CONTINUIDADE: todas as cenas no MESMO cenário, com a mesma iluminação; descreva o cenário no initialFrame.',
    '- "dialogue": fala em pt-BR de varejo, natural e entusiasmada; null em cenas "action". ' +
      'Presenter e action_voiceover EXIGEM fala.',
    '- REGRA CRÍTICA DE DURAÇÃO: em "action_voiceover" a narração PRECISA CABER na cena ' +
      '(fale ~2,5 palavras por segundo: cena de 5s ≈ 12 palavras, de 10s ≈ 25 palavras); ' +
      'em "presenter" a fala preenche a cena (cena de 6s ≈ 15 palavras).',
    '- Preços SEMPRE por extenso na fala (ex.: "nove e noventa e nove").',
    '- "productIndex": índice do produto anunciado NESTA cena (o selo de preço usa isso) ou null ' +
      'quando a cena não anuncia produto (ex.: abertura, convite final).',
    '- NADA de texto escrito, placas, etiquetas ou números na descrição visual: preço, nome do ' +
      'produto e da loja entram depois como camada gráfica.',
    '- Deixe o terço inferior da imagem livre para a camada gráfica (descreva o mascote no centro/topo).',
    '- A última cena pode ser um convite/chamada para ação. Não invente promoções fora do briefing.',
  ];
  if (productList)
    lines.push(`- Produtos em oferta (use o índice em productIndex): ${productList}.`);
  else lines.push('- Não há produtos cadastrados: productIndex é sempre null.');
  return lines.join('\n');
}

/** json_schema ESTRITO da resposta do diretor v2. */
export function buildDirectorJsonSchemaV2(): Record<string, unknown> {
  return {
    name: 'roteiro_comercial_v2',
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
              sceneType: { type: 'string', enum: ['presenter', 'action', 'action_voiceover'] },
              initialFrame: { type: 'string' },
              initialFrameEn: { type: 'string' },
              actionPrompt: { type: 'string' },
              actionPromptEn: { type: 'string' },
              dialogue: { type: ['string', 'null'] },
              durationS: { type: 'integer' },
              productIndex: { type: ['integer', 'null'] },
            },
            required: [
              'sceneType',
              'initialFrame',
              'initialFrameEn',
              'actionPrompt',
              'actionPromptEn',
              'dialogue',
              'durationS',
              'productIndex',
            ],
          },
        },
      },
      required: ['scenes'],
    },
  };
}

export interface RawDirectorSceneV2 extends RawDirectorScene {
  sceneType?: string | null;
  initialFrame?: string | null;
  initialFrameEn?: string | null;
  productIndex?: number | null;
}

/**
 * Normaliza a saída do diretor v2 em cenas v2 válidas: identidade nova por
 * cena, tipo validado (fala × tipo corrigida: action com fala vira
 * action_voiceover; presenter/voiceover sem fala vira action), produto por
 * índice → id do snapshot, derivação EN gravada com o hash da intenção.
 */
export function normalizeDirectorScenesV2(
  raw: RawDirectorSceneV2[],
  products: McSealProduct[],
  idFactory: () => string,
  provider = 'director',
): McScriptScene[] {
  const scenes: McScriptScene[] = [];
  for (const item of raw ?? []) {
    if (scenes.length >= MC_MAX_SCENES) break;
    const actionPrompt = (item?.actionPrompt ?? '').trim();
    if (!actionPrompt) continue;
    const durationS = Math.min(
      MC_SCENE_MAX_S,
      Math.max(MC_SCENE_MIN_S, Math.round(Number(item?.durationS) || MC_SCENE_MIN_S)),
    );
    const dialogueRaw = (item?.dialogue ?? '').trim();
    let sceneType: McSceneType =
      item?.sceneType === 'presenter' ||
      item?.sceneType === 'action' ||
      item?.sceneType === 'action_voiceover'
        ? item.sceneType
        : dialogueRaw
          ? 'presenter'
          : 'action';
    if (sceneType === 'action' && dialogueRaw) sceneType = 'action_voiceover';
    if (sceneType !== 'action' && !dialogueRaw) sceneType = 'action';
    const dialogue =
      sceneType === 'action' ? null : dialogueRaw.slice(0, durationS * MC_CHARS_PER_SECOND + 40);
    const index = item?.productIndex;
    const productRef =
      typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < products.length
        ? (products[index].id ?? null)
        : null;
    const scene: McScriptScene = {
      idx: scenes.length,
      sceneId: idFactory(),
      sceneType,
      initialFrame: (item?.initialFrame ?? '').trim() || undefined,
      camera: null,
      environmentId: null,
      productRef,
      sealCue: defaultSealCue(durationS),
      safeArea: 'lower_third',
      actionPrompt,
      dialogue,
      durationS,
    };
    const actionPromptEn = (item?.actionPromptEn ?? '').trim();
    const initialFrameEn = (item?.initialFrameEn ?? '').trim();
    if (actionPromptEn) {
      scene.derived = {
        sourceHash: sceneSourceHash(scene),
        initialFrameEn: initialFrameEn || null,
        actionPromptEn,
        lang: 'en',
        provider,
        at: new Date().toISOString(),
      };
    }
    scenes.push(scene);
  }
  if (scenes.length === 0) {
    throw new Error('script_failed: diretor devolveu roteiro sem cenas utilizáveis');
  }
  return scenes;
}

/** Snapshot de produtos do roteiro v2 a partir das opções do projeto (ids já atribuídos na criação). */
export function buildProductsSnapshot(
  products: McSealProduct[],
  idFactory: () => string,
): McSealProduct[] {
  return products
    .filter((p) => p?.name?.trim() && p?.price?.trim())
    .slice(0, MC_MAX_SEAL_PRODUCTS)
    .map((p) => ({
      id: p.id ?? idFactory(),
      catalogId: p.catalogId ?? null,
      unit: p.unit ?? null,
      imageUrl: p.imageUrl ?? null,
      name: p.name.trim(),
      price: p.price.trim(),
    }));
}

/**
 * Roteiro MOCK v2 (MC_SCRIPT_PROVIDER=mock): 3 cenas — presenter,
 * action_voiceover e action — o material do e2e de custo zero que exercita
 * os três grafos (Avatar; ação + TTS + scene_compose; ação).
 */
export function buildMockScriptV2(
  input: { products?: McSealProduct[]; storeName?: string | null },
  idFactory: () => string,
): McScript {
  const products = buildProductsSnapshot(input.products ?? [], idFactory);
  const endcard = buildEndcard(input.storeName);
  const raw: RawDirectorSceneV2[] = [
    {
      sceneType: 'presenter',
      initialFrame:
        'O mascote de frente para a câmera no corredor do supermercado, ao lado das gôndolas, terço inferior livre.',
      initialFrameEn:
        'The mascot facing the camera in a supermarket aisle, next to the shelves, lower third of the frame clear.',
      actionPrompt: 'Acena para a câmera e sorri.',
      actionPromptEn: 'The mascot waves at the camera and smiles.',
      dialogue: 'Bem-vindo às ofertas da semana!',
      durationS: 6,
      productIndex: null,
    },
    {
      sceneType: 'action_voiceover',
      initialFrame:
        'No mesmo corredor, uma caixa de produto na prateleira e a mão do mascote próxima dela.',
      initialFrameEn:
        "In the same aisle, a product box on the shelf with the mascot's hand close to it.",
      actionPrompt: 'Pega a caixa da prateleira e apresenta para a câmera.',
      actionPromptEn: 'The mascot picks the box from the shelf and presents it to the camera.',
      dialogue: 'Leve hoje por nove e noventa e nove!',
      durationS: 5,
      productIndex: products.length > 0 ? 0 : null,
    },
    {
      sceneType: 'action',
      initialFrame: 'Ainda no mesmo corredor, o mascote de corpo inteiro, mãos livres.',
      initialFrameEn: 'Still in the same aisle, the mascot full body, hands free.',
      actionPrompt: 'Dá um joinha e sorri para a câmera.',
      actionPromptEn: 'The mascot gives a thumbs up and smiles at the camera.',
      dialogue: null,
      durationS: 4,
      productIndex: null,
    },
  ];
  return {
    version: 1,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    products,
    environments: [],
    scenes: normalizeDirectorScenesV2(raw, products, idFactory, 'mock'),
    seal: null,
    endcard: endcard ?? null,
  };
}
