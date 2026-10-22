import { MC_OFFER_PIECE_MIN_OFFERS } from './mc-piece';
import { numeroPorExtenso, parsePreco, precoPorExtenso } from './mc-preco-extenso';
import { MC_SCRIPT_SCHEMA_V2 } from './mc-quality';
import { defaultSealCue, sceneSourceHash } from './mc-script-v2';
import { estimateSpeechSecondsRaw } from './mc-speech-estimate';
import {
  artBoxToOutputWindow,
  defaultCharacterWindow,
  windowPxToFractions,
} from './mc-talking-art-window';
import {
  MC_OFFER_CAROUSEL_MAX_OFFERS,
  MC_OFFER_CAROUSEL_MAX_SPEECH_S,
  MC_OFFER_CAROUSEL_MIN_OFFERS,
  McCarouselLayoutPreset,
  McCarouselLine,
  MC_TALKING_ART_MAX_CITED_OFFERS,
  MC_TALKING_ART_MAX_S,
  MC_TALKING_ART_MAX_SCENES,
  MC_TALKING_ART_MIN_S,
  MC_TALKING_ART_NARRATION_MAX_CHARS,
  MC_TALKING_ART_NARRATION_MIN_CHARS,
  McCharacterWindow,
  McLogoBox,
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
              sceneType: {
                type: 'string',
                enum: ['presenter', 'action', 'action_voiceover', 'talk_tile'],
              },
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
 *
 * `talk_tile` (D6/D7) NÃO é coagido pela fala: é uma fala = um clipe a partir
 * do tile — sem keyframe (`initialFrame`/cenário/selo ausentes), gesto
 * opcional em `actionPrompt` (vazio permitido) e fala obrigatória (item sem
 * fala é descartado).
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
    const talkTile = item?.sceneType === 'talk_tile';
    if (!actionPrompt && !talkTile) continue;
    const durationS = Math.min(
      MC_SCENE_MAX_S,
      Math.max(MC_SCENE_MIN_S, Math.round(Number(item?.durationS) || MC_SCENE_MIN_S)),
    );
    const dialogueRaw = (item?.dialogue ?? '').trim();
    if (talkTile && !dialogueRaw) continue;
    let sceneType: McSceneType =
      item?.sceneType === 'presenter' ||
      item?.sceneType === 'action' ||
      item?.sceneType === 'action_voiceover' ||
      talkTile
        ? (item.sceneType as McSceneType)
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
    const scene: McScriptScene = talkTile
      ? {
          idx: scenes.length,
          sceneId: idFactory(),
          sceneType,
          camera: null,
          environmentId: null,
          productRef,
          sealCue: null,
          safeArea: null,
          actionPrompt,
          dialogue,
          durationS,
        }
      : {
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

/**
 * Snapshot de produtos do roteiro v2 a partir das opções do projeto (ids já
 * atribuídos na criação). O teto default é o dos selos do F3 (6); o F1 recebe
 * TODAS as ofertas da arte (até `MC_TALKING_ART_MAX_OFFERS`) para o diretor
 * escolher quais citar.
 */
export function buildProductsSnapshot(
  products: McSealProduct[],
  idFactory: () => string,
  max: number = MC_MAX_SEAL_PRODUCTS,
): McSealProduct[] {
  return products
    .filter((p) => p?.name?.trim() && p?.price?.trim())
    .slice(0, max)
    .map((p) => ({
      id: p.id ?? idFactory(),
      catalogId: p.catalogId ?? null,
      unit: p.unit ?? null,
      imageUrl: p.imageUrl ?? null,
      name: p.name.trim(),
      price: p.price.trim(),
      // Preço anterior e badge vêm congelados da arte (D9) — o F2 os mostra no card.
      originalPrice: p.originalPrice?.trim() || null,
      badge: p.badge?.trim() || null,
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

// ─────────────────── F1: arte que fala (change video-formatos-personagem, D6) ───────────────────

/**
 * Contexto do diretor F1 — o que o roteiro precisa além do briefing: snapshot
 * de produtos (ofertas da arte), cartela, limite do motor por fala
 * (`maxChunkS`), quadro de saída e tile do kit (aspecto da janela), e o modo
 * rosto do logo (kit `logo_as_is` com a caixa do logo resolvida na ponte).
 */
export interface DirectorF1Context {
  products: McSealProduct[];
  storeName: string | null;
  maxChunkS: number;
  frame: { width: number; height: number };
  tile: { width: number | null; height: number | null };
  /** Dimensões da arte de fundo (a caixa do logo vem em frações da ARTE, não do quadro). */
  art?: { width: number | null; height: number | null } | null;
  logoFace: boolean;
  logoBox: McLogoBox | null;
}

/**
 * System prompt do diretor F1 (spec "Fala a partir das ofertas da arte"):
 * apresentação de 6 a 25 s (mira 10–20 s), cita no máximo 3 ofertas com preço
 * por extenso, convida a ver as demais, 90–375 caracteres. O diretor devolve
 * SÓ o texto e os índices das ofertas citadas — a divisão em falas (cenas
 * `talk_tile`) é determinística aqui (`buildTalkingArtScenes`), por fronteira
 * de frase sob o limite do motor.
 */
export function buildDirectorSystemPromptF1(opts: {
  products: McSealProduct[];
  storeName: string | null;
  maxChunkS: number;
}): string {
  const productList =
    opts.products.length > 0
      ? opts.products
          .map((p, i) => `[${i}] ${p.name} (R$ ${p.price}${p.unit ? ` / ${p.unit}` : ''})`)
          .join('; ')
      : null;
  const lines = [
    'Você escreve a fala de um personagem (mascote ou logo animado) que apresenta uma arte ' +
      'promocional de supermercado já pronta — a arte aparece inteira no vídeo e o personagem ' +
      'fala numa janela sobre ela.',
    `Escreva UMA apresentação em pt-BR de varejo, natural e entusiasmada, de ${MC_TALKING_ART_MIN_S} a ` +
      `${MC_TALKING_ART_MAX_S} segundos falados (mire entre 10 e 20 segundos; ~${MC_CHARS_PER_SECOND} ` +
      `caracteres por segundo, ou seja, entre ${MC_TALKING_ART_NARRATION_MIN_CHARS} e ` +
      `${MC_TALKING_ART_NARRATION_MAX_CHARS} caracteres).`,
    '',
    'Regras obrigatórias:',
    `- Cite NO MÁXIMO ${MC_TALKING_ART_MAX_CITED_OFFERS} ofertas da lista, com o preço SEMPRE por ` +
      'extenso (ex.: "vinte e quatro reais e noventa centavos", nunca "24,90" ou "R$ 24,90").',
    '- Convide o público a ver as demais ofertas na arte/na loja (a arte tem mais ofertas do que você cita).',
    '- Frases curtas e completas, separadas por ponto final: cada frase vira um trecho falado ' +
      `de no máximo ${opts.maxChunkS} segundos (~${Math.floor(opts.maxChunkS * MC_CHARS_PER_SECOND)} caracteres).`,
    '- Nada de texto escrito, placas, hashtags, emojis ou instruções de câmera — só a fala.',
    '- Não invente ofertas, preços ou condições fora da lista.',
    '- "citedOfferIndexes": os índices das ofertas que você citou (na ordem em que aparecem na fala), ' +
      `no máximo ${MC_TALKING_ART_MAX_CITED_OFFERS}; vazio se não citou nenhuma.`,
  ];
  if (productList)
    lines.push(`- Ofertas da arte (use o índice em citedOfferIndexes): ${productList}.`);
  else lines.push('- A arte não tem ofertas cadastradas: citedOfferIndexes é sempre vazio.');
  if (opts.storeName) lines.push(`- A loja se chama "${opts.storeName}" — pode citá-la uma vez.`);
  return lines.join('\n');
}

/** json_schema ESTRITO da resposta do diretor F1: narração + índices citados. */
export function buildDirectorJsonSchemaF1(): Record<string, unknown> {
  return {
    name: 'fala_arte_que_fala',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        narration: { type: 'string' },
        citedOfferIndexes: {
          type: 'array',
          maxItems: MC_TALKING_ART_MAX_CITED_OFFERS,
          items: { type: 'integer' },
        },
      },
      required: ['narration', 'citedOfferIndexes'],
    },
  };
}

export interface RawDirectorF1 {
  narration?: string | null;
  citedOfferIndexes?: number[] | null;
}

/** Frases do texto (pontuação final preservada), sem vazios. */
export function splitSentences(text: string): string[] {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^.!?…]+[.!?…]+["”)]?|[^.!?…]+$/g) ?? [normalized];
  return matches.map((s) => s.trim()).filter(Boolean);
}

/** Divide uma frase longa demais em pedaços ≤ maxChunkS (vírgulas/ponto e vírgula; senão por palavra). */
function splitLongSentence(sentence: string, maxChunkS: number): string[] {
  if (estimateSpeechSecondsRaw(sentence) <= maxChunkS) return [sentence];
  const parts = sentence.split(/(?<=[,;:])\s+/).filter(Boolean);
  const units = parts.length > 1 ? parts : sentence.split(/\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current} ${unit}` : unit;
    if (current && estimateSpeechSecondsRaw(candidate) > maxChunkS) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Divisão da narração em 1 a `maxScenes` falas por FRONTEIRA DE FRASE, cada
 * uma com estimativa ≤ `maxChunkS` (D6/D7). Frase isolada acima do limite é
 * quebrada em vírgulas (ou palavras). Mais pedaços que `maxScenes` são
 * fundidos no último — a revisão então bloqueia com SPEECH_SENTENCE_TOO_LONG
 * (duração medida), nunca corta texto em silêncio.
 */
export function chunkNarration(
  narration: string,
  maxChunkS: number,
  maxScenes: number = MC_TALKING_ART_MAX_SCENES,
): string[] {
  const pieces = splitSentences(narration).flatMap((s) => splitLongSentence(s, maxChunkS));
  if (pieces.length === 0) return [];
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (current && estimateSpeechSecondsRaw(candidate) > maxChunkS) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length > maxScenes) {
    const head = chunks.slice(0, maxScenes - 1);
    const tail = chunks.slice(maxScenes - 1).join(' ');
    return [...head, tail];
  }
  return chunks;
}

function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Palavras "fortes" do nome do produto (≥ 3 letras, sem unidades/números). */
function productKeywords(name: string): string[] {
  return foldText(name)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d/.test(w))
    .slice(0, 3);
}

/** Oferta citada cujo nome aparece no trecho (primeira palavra forte do nome); null = trecho sem oferta. */
export function matchCitedOffer(text: string, cited: McSealProduct[]): string | null {
  const folded = foldText(text);
  for (const product of cited) {
    if (!product.id) continue;
    const keywords = productKeywords(product.name);
    if (keywords.length > 0 && folded.includes(keywords[0])) return product.id;
  }
  return null;
}

/** Duração planejada (s) de uma fala, dentro da forma aceita pelo DTO (3..30). */
export function plannedTalkDurationS(text: string): number {
  return Math.min(
    MC_SCENE_MAX_S + 18,
    Math.max(MC_SCENE_MIN_S - 1, Math.round(estimateSpeechSecondsRaw(text))),
  );
}

/**
 * Cenas `talk_tile` do F1 (contrato do grupo 3): identidade estável, `idx`,
 * fala, duração estimada, gesto opcional (só na primeira, quando informado),
 * `productRef` = oferta citada no trecho ou null; sem initialFrame/cenário/selo.
 */
export function buildTalkingArtScenes(
  narration: string,
  opts: {
    maxChunkS: number;
    idFactory: () => string;
    citedProducts: McSealProduct[];
    gesture?: string | null;
  },
): McScriptScene[] {
  return chunkNarration(narration, opts.maxChunkS).map((dialogue, idx) => ({
    idx,
    sceneId: opts.idFactory(),
    sceneType: 'talk_tile' as const,
    camera: null,
    environmentId: null,
    productRef: matchCitedOffer(dialogue, opts.citedProducts),
    sealCue: null,
    safeArea: null,
    actionPrompt: idx === 0 ? (opts.gesture ?? '').trim() : '',
    dialogue,
    durationS: plannedTalkDurationS(dialogue),
  }));
}

/** Corta a narração no fim de frase mais próximo do teto quando o diretor passa do limite. */
export function clampNarration(
  narration: string,
  maxChars: number = MC_TALKING_ART_NARRATION_MAX_CHARS,
): string {
  const text = (narration ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const sentences = splitSentences(text);
  let out = '';
  for (const sentence of sentences) {
    const candidate = out ? `${out} ${sentence}` : sentence;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  return out.length >= MC_TALKING_ART_NARRATION_MIN_CHARS ? out : text.slice(0, maxChars).trim();
}

/** Janela do roteiro F1: a caixa do logo no modo rosto do logo; senão o preset default (canto inferior direito). */
export function talkingArtWindow(ctx: DirectorF1Context): McCharacterWindow {
  if (ctx.logoFace && ctx.logoBox) {
    // A caixa está em frações da arte; a janela do roteiro é em frações do quadro de
    // saída. Converte pela mesma transformação contain-fit do compose (faixas de
    // preenchimento incluídas). Sem as dimensões da arte, cai na caixa como está.
    const artW = ctx.art?.width;
    const artH = ctx.art?.height;
    if (artW && artH) {
      const px = artBoxToOutputWindow(ctx.logoBox, artW, artH, ctx.frame.width, ctx.frame.height);
      return windowPxToFractions(px, ctx.frame.width, ctx.frame.height);
    }
    return { x: ctx.logoBox.x, y: ctx.logoBox.y, w: ctx.logoBox.w, h: ctx.logoBox.h };
  }
  return defaultCharacterWindow({
    width: ctx.frame.width,
    height: ctx.frame.height,
    tileWidth: ctx.tile.width,
    tileHeight: ctx.tile.height,
  });
}

/**
 * Roteiro F1 a partir da resposta do diretor (LLM ou mock): narração aparada
 * ao teto, ofertas citadas por índice (válidas, únicas, ≤ 3), cenas por
 * frase sob `maxChunkS`, janela e modo rosto do logo. `schemaVersion = 2`.
 */
export function buildTalkingArtScript(
  raw: RawDirectorF1,
  ctx: DirectorF1Context,
  idFactory: () => string,
  opts: { gesture?: string | null } = {},
): McScript {
  const narration = clampNarration(raw?.narration ?? '');
  if (!narration) throw new Error('script_failed: diretor devolveu narração vazia');
  const citedOfferIds: string[] = [];
  for (const index of raw?.citedOfferIndexes ?? []) {
    if (citedOfferIds.length >= MC_TALKING_ART_MAX_CITED_OFFERS) break;
    if (!Number.isInteger(index) || index < 0 || index >= ctx.products.length) continue;
    const id = ctx.products[index].id;
    if (id && !citedOfferIds.includes(id)) citedOfferIds.push(id);
  }
  const citedProducts = ctx.products.filter((p) => p.id && citedOfferIds.includes(p.id));
  const scenes = buildTalkingArtScenes(narration, {
    maxChunkS: ctx.maxChunkS,
    idFactory,
    citedProducts,
    gesture: opts.gesture ?? null,
  });
  if (scenes.length === 0) throw new Error('script_failed: narração sem frases utilizáveis');
  const endcard = buildEndcard(ctx.storeName);
  return {
    version: 1,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    format: 'talking_art',
    products: ctx.products,
    environments: [],
    scenes,
    seal: null,
    endcard: endcard ?? null,
    narration,
    window: talkingArtWindow(ctx),
    logoFace: ctx.logoFace && !!ctx.logoBox,
    citedOfferIds,
  };
}

/** Nome curto do produto para a fala mock (até `maxWords` palavras, default 4). */
function shortProductName(name: string, maxWords = 4): string {
  return name.trim().split(/\s+/).slice(0, maxWords).join(' ');
}

/**
 * Narração MOCK do F1 (MC_SCRIPT_PROVIDER=mock): abertura, até 3 ofertas com
 * preço por extenso, convite — dentro de 90–375 caracteres (descarta ofertas
 * do fim enquanto passar do teto). Determinística: o e2e de custo zero
 * atravessa TTS → talk → compose → finalize com números realistas.
 */
export function buildMockNarrationF1(input: {
  products: McSealProduct[];
  storeName: string | null;
}): { narration: string; citedOfferIndexes: number[] } {
  const opening = `Olá! Chegaram as ofertas da semana${input.storeName ? ` no ${input.storeName.trim()}` : ''}.`;
  const closing = 'Corra e aproveite, tem muito mais oferta esperando por você na arte!';
  const valid = input.products
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p?.name?.trim() && p?.price?.trim());
  for (
    let count = Math.min(MC_TALKING_ART_MAX_CITED_OFFERS, valid.length);
    count >= 0;
    count -= 1
  ) {
    const chosen = valid.slice(0, count);
    const offers = chosen.map(
      ({ p }) => `${shortProductName(p.name)} por ${precoPorExtenso(p.price)}`,
    );
    const offerSentence =
      offers.length === 0
        ? 'Vem conferir os preços baixos que preparamos para você.'
        : offers.length === 1
          ? `${offers[0]}.`
          : `${offers.slice(0, -1).join(', ')} e ${offers[offers.length - 1]}.`;
    const narration = `${opening} ${offerSentence} ${closing}`;
    if (narration.length <= MC_TALKING_ART_NARRATION_MAX_CHARS || count === 0) {
      return { narration, citedOfferIndexes: chosen.map(({ index }) => index) };
    }
  }
  return { narration: `${opening} ${closing}`, citedOfferIndexes: [] };
}

/** Roteiro MOCK F1: narração determinística + cenas por frase sob o limite do motor. */
export function buildMockScriptF1(ctx: DirectorF1Context, idFactory: () => string): McScript {
  const raw = buildMockNarrationF1({ products: ctx.products, storeName: ctx.storeName });
  return buildTalkingArtScript(raw, ctx, idFactory, { gesture: 'Acena no início.' });
}

// ─────────────── F2: ofertas em sequência (change video-formatos-personagem, tarefa 6.6) ───────────────

/**
 * Contexto do diretor F2: as ofertas CONGELADAS (3 a 6, na ordem do vídeo, com
 * ids estáveis), a loja (abertura/fechamento), o limite do motor por fala e as
 * escolhas de composição (preset de layout e legendas por palavra).
 */
export interface DirectorF2Context {
  offers: McSealProduct[];
  storeName: string | null;
  maxChunkS: number;
  layoutPreset: McCarouselLayoutPreset;
  captions: boolean;
}

/** Folga do orçamento estimado: o diretor mira ≤ 30 s de fala (o TTS medido decide na revisão). */
export const MC_OFFER_CAROUSEL_TARGET_SPEECH_S = MC_OFFER_CAROUSEL_MAX_SPEECH_S;

const CAROUSEL_OPENING_DEFAULT = 'Olá! Confira as ofertas de hoje.';
const CAROUSEL_OPENING_SHORT = 'Ofertas de hoje!';
const CAROUSEL_CLOSING_DEFAULT = 'Corre pro mercado e aproveite!';
const CAROUSEL_CLOSING_SHORT = 'Aproveite!';

/**
 * System prompt do diretor F2 (spec video-offer-carousel "Uma fala por
 * oferta"): abertura curta, UMA fala por oferta NA ORDEM dada citando nome e
 * preço por extenso, fechamento com convite; soma ≤ 30 s falados.
 */
export function buildDirectorSystemPromptF2(opts: {
  offers: McSealProduct[];
  storeName: string | null;
  maxChunkS: number;
  /** Peça de ofertas: validade do rodapé para o fechamento citar ("até 16/04"). */
  closingHint?: string | null;
}): string {
  const list = opts.offers
    .map(
      (p, i) =>
        `[${i}] ${p.name} — R$ ${p.price}${p.unit ? ` / ${p.unit}` : ''} ` +
        `(fale: "${precoPorExtenso(p.price)}")`,
    )
    .join('; ');
  const perOfferS = Math.max(
    2.5,
    Math.min(5, (MC_OFFER_CAROUSEL_TARGET_SPEECH_S - 5) / Math.max(1, opts.offers.length)),
  );
  const lines = [
    'Você escreve as falas de um personagem (mascote ou logo animado) que apresenta ofertas de ' +
      'supermercado uma a uma; cada oferta aparece num card com foto, nome e preço enquanto ele fala.',
    `Escreva em pt-BR de varejo, natural e entusiasmado: uma ABERTURA curta, UMA fala para cada ` +
      `uma das ${opts.offers.length} ofertas, NA ORDEM dada, e um FECHAMENTO com convite.`,
    '',
    'Regras obrigatórias:',
    `- A soma de todas as falas precisa caber em ${MC_OFFER_CAROUSEL_MAX_SPEECH_S} segundos ` +
      `(~${MC_CHARS_PER_SECOND} caracteres por segundo): abertura e fechamento com até 2,5 s ` +
      `(~35 caracteres) cada, e cada oferta com até ${perOfferS.toFixed(1)} s ` +
      `(~${Math.floor(perOfferS * MC_CHARS_PER_SECOND)} caracteres).`,
    '- Cada fala de oferta cita o NOME do produto e o PREÇO SEMPRE por extenso, exatamente como ' +
      'indicado (ex.: "vinte e quatro reais e noventa centavos", nunca "24,90" ou "R$ 24,90").',
    `- Uma frase curta por fala (no máximo ${opts.maxChunkS} segundos cada).`,
    '- Não invente ofertas, preços, descontos ou condições fora da lista; não fale o preço anterior.',
    '- Nada de hashtags, emojis, instruções de câmera ou texto para a tela — só a fala.',
    '- "offerLines": um item por oferta com o "offerIndex" da lista e o "text" da fala, na ordem dada.',
    `- Ofertas (na ordem do vídeo): ${list}.`,
  ];
  if (opts.storeName) lines.push(`- A loja se chama "${opts.storeName}" — pode citá-la uma vez.`);
  if (opts.closingHint?.trim()) {
    lines.push(`- No FECHAMENTO, diga que as ofertas valem ${opts.closingHint.trim()}.`);
  }
  return lines.join('\n');
}

/** json_schema ESTRITO do diretor F2: abertura + exatamente uma fala por oferta + fechamento. */
export function buildDirectorJsonSchemaF2(offerCount: number): Record<string, unknown> {
  const count = Math.min(
    MC_OFFER_CAROUSEL_MAX_OFFERS,
    Math.max(MC_OFFER_CAROUSEL_MIN_OFFERS, Math.round(offerCount)),
  );
  return {
    name: 'falas_ofertas_em_sequencia',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        opening: { type: 'string' },
        offerLines: {
          type: 'array',
          minItems: count,
          maxItems: count,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              offerIndex: { type: 'integer' },
              text: { type: 'string' },
            },
            required: ['offerIndex', 'text'],
          },
        },
        closing: { type: 'string' },
      },
      required: ['opening', 'offerLines', 'closing'],
    },
  };
}

export interface RawDirectorF2 {
  opening?: string | null;
  offerLines?: Array<{ offerIndex?: number | null; text?: string | null }> | null;
  closing?: string | null;
}

/** "R$ 24,90" / "24,90" / "1.299,00" na fala → por extenso (nunca números lidos pelo TTS). */
export function spellOutPrices(text: string): string {
  return (text ?? '').replace(
    /(?:R\$\s*)?\b\d{1,3}(?:\.\d{3})*,\d{1,2}\b|R\$\s*\d+(?:,\d{1,2})?\b/g,
    (match) => precoPorExtenso(match),
  );
}

/** A fala cita o preço por extenso? (reais e centavos por extenso, sem aritmética). */
export function lineCitesPrice(text: string, price: string): boolean {
  const parsed = parsePreco(price);
  if (!parsed) return false;
  const folded = foldText(text);
  if (folded.includes(foldText(precoPorExtenso(price)))) return true;
  const reaisOk = parsed.reais === 0 || folded.includes(foldText(numeroPorExtenso(parsed.reais)));
  const centavosOk =
    parsed.centavos === 0 || folded.includes(foldText(numeroPorExtenso(parsed.centavos)));
  return reaisOk && centavosOk;
}

/** A fala cita o nome da oferta? (primeira palavra forte do nome). */
export function lineCitesOffer(text: string, offer: McSealProduct): boolean {
  const keywords = productKeywords(offer.name);
  if (keywords.length === 0) return true;
  return foldText(text).includes(keywords[0]);
}

const MEASURE_UNIT = /^(?:kg|g|mg|ml|l|lt|un|und|unid|cx|pct|dz|m)$/i;

/**
 * Nome falado da oferta: até `maxWords` palavras, sem gramatura solta no fim
 * ("Óleo de Soja 900 ml" → "Óleo de Soja"; "Leite Integral 1 L" → "Leite
 * Integral"); números que não são medida ficam ("Arroz Branco Tipo 1").
 */
export function spokenProductName(name: string, maxWords = 4): string {
  const words = name.trim().split(/\s+/);
  const cut = words.slice(0, maxWords);
  const isMeasureNumber = (index: number) =>
    /^\d+(?:[.,]\d+)?$/.test(words[index] ?? '') && MEASURE_UNIT.test(words[index + 1] ?? '');
  while (cut.length > 1) {
    const last = cut.length - 1;
    if (MEASURE_UNIT.test(cut[last]) || /^\d+(?:[.,]\d+)?(?:kg|g|ml|l)$/i.test(cut[last])) {
      cut.pop();
    } else if (isMeasureNumber(last)) {
      cut.pop();
    } else break;
  }
  return cut.join(' ');
}

const UNIT_SPOKEN: Record<string, string> = {
  kg: 'o quilo',
  un: 'a unidade',
  und: 'a unidade',
  unid: 'a unidade',
  l: 'o litro',
  lt: 'o litro',
  dz: 'a dúzia',
};

/**
 * Fala DETERMINÍSTICA de uma oferta (o "line builder" do diretor F2): nome
 * curto + preço por extenso (+ unidade falada quando é kg/un/litro/dúzia).
 * É o que o mock usa, o fallback quando o LLM não cita nome ou preço, e a
 * PROPOSTA de nova fala quando o nome ou o preço atual da oferta mudam (6.8).
 */
export function buildOfferLineText(
  offer: Pick<McSealProduct, 'name' | 'price' | 'unit'>,
  opts: { maxWords?: number; compact?: boolean } = {},
): string {
  const name = spokenProductName(offer.name, opts.maxWords ?? 4);
  const unit = UNIT_SPOKEN[(offer.unit ?? '').trim().toLowerCase().replace(/^\//, '')];
  const price = precoPorExtenso(offer.price);
  const priced = unit ? `${price} ${unit}` : price;
  return opts.compact ? `${name}, ${priced}!` : `${name} por ${priced}!`;
}

/** Soma ESTIMADA (s) das falas — a mesma régua de 15 caracteres/s do TTS mock. */
export function estimateCarouselSpeechS(texts: string[]): number {
  return Number(texts.reduce((sum, t) => sum + estimateSpeechSecondsRaw(t), 0).toFixed(1));
}

interface CarouselTexts {
  opening: string;
  offers: string[];
  closing: string;
}

/**
 * Cabe no orçamento estimado (≤ 30 s)? Encurta em degraus, sem cortar
 * palavras: abertura/fechamento curtos → falas compactas das ofertas que
 * passaram do formato determinístico → nomes de 2 palavras. Acima disso o
 * roteiro segue e a revisão bloqueia pelo TTS medido (SPEECH_OVER_LENGTH).
 */
export function fitCarouselTexts(texts: CarouselTexts, offers: McSealProduct[]): CarouselTexts {
  const total = (t: CarouselTexts) => estimateCarouselSpeechS([t.opening, ...t.offers, t.closing]);
  let current = { ...texts, offers: [...texts.offers] };
  if (total(current) <= MC_OFFER_CAROUSEL_TARGET_SPEECH_S) return current;
  current = { ...current, opening: CAROUSEL_OPENING_SHORT, closing: CAROUSEL_CLOSING_SHORT };
  if (total(current) <= MC_OFFER_CAROUSEL_TARGET_SPEECH_S) return current;
  for (const maxWords of [3, 2]) {
    current = {
      ...current,
      offers: current.offers.map((text, i) => {
        const compact = buildOfferLineText(offers[i], { maxWords, compact: true });
        return compact.length < text.length ? compact : text;
      }),
    };
    if (total(current) <= MC_OFFER_CAROUSEL_TARGET_SPEECH_S) return current;
  }
  return current;
}

function cleanLine(text: string | null | undefined): string {
  return spellOutPrices((text ?? '').replace(/\s+/g, ' ').trim());
}

/**
 * Cenas `talk_tile` do F2 + falas (D6): abertura, uma por oferta (com
 * `productRef = offerRef`) e fechamento, cada uma com identidade estável e
 * duração estimada; sem keyframe, cenário ou selo.
 */
export function buildCarouselScenes(
  texts: CarouselTexts,
  offers: McSealProduct[],
  idFactory: () => string,
): { scenes: McScriptScene[]; lines: McCarouselLine[] } {
  const entries: Array<{ text: string; kind: McCarouselLine['kind']; offerRef: string | null }> = [
    { text: texts.opening, kind: 'opening', offerRef: null },
    ...texts.offers.map((text, i) => ({
      text,
      kind: 'offer' as const,
      offerRef: offers[i].id ?? null,
    })),
    { text: texts.closing, kind: 'closing', offerRef: null },
  ];
  const scenes: McScriptScene[] = entries.map((entry, idx) => ({
    idx,
    sceneId: idFactory(),
    sceneType: 'talk_tile' as const,
    camera: null,
    environmentId: null,
    productRef: entry.offerRef,
    sealCue: null,
    safeArea: null,
    actionPrompt: idx === 0 ? 'Acena no início.' : '',
    dialogue: entry.text,
    durationS: plannedTalkDurationS(entry.text),
  }));
  const lines: McCarouselLine[] = entries.map((entry, idx) => ({
    sceneId: scenes[idx].sceneId as string,
    kind: entry.kind,
    offerRef: entry.offerRef,
  }));
  return { scenes, lines };
}

/**
 * Roteiro F2 a partir da resposta do diretor (LLM ou mock): uma fala por
 * oferta NA ORDEM congelada (a do LLM quando cita nome e preço por extenso;
 * senão a determinística), abertura/fechamento (defaults quando vazios),
 * orçamento ≤ 30 s estimado, `offers[]` = `products[]` espelhados.
 */
export function buildOfferCarouselScript(
  raw: RawDirectorF2,
  ctx: DirectorF2Context,
  idFactory: () => string,
): McScript {
  return buildCarouselLikeScript(raw, ctx, idFactory, {
    format: 'offer_carousel',
    minOffers: MC_OFFER_CAROUSEL_MIN_OFFERS,
    label: '"ofertas em sequência"',
  });
}

/**
 * Núcleo compartilhado pelo F2 e pela peça de ofertas: mesma validação das
 * falas, mesmo encurtamento e mesmas cenas `talk_tile`; só o formato e o
 * mínimo de ofertas mudam (a peça fala a partir de uma oferta).
 */
function buildCarouselLikeScript(
  raw: RawDirectorF2,
  ctx: DirectorF2Context,
  idFactory: () => string,
  opts: { format: 'offer_carousel' | 'offer_piece'; minOffers: number; label: string },
): McScript {
  const offers = ctx.offers.map((o) => ({ ...o, id: o.id ?? idFactory() }));
  if (offers.length < opts.minOffers || offers.length > MC_OFFER_CAROUSEL_MAX_OFFERS) {
    throw new Error(
      `script_failed: ${opts.label} pede de ${opts.minOffers} a ` +
        `${MC_OFFER_CAROUSEL_MAX_OFFERS} ofertas (recebidas: ${offers.length})`,
    );
  }
  const byIndex = new Map<number, string>();
  for (const item of raw?.offerLines ?? []) {
    const index = item?.offerIndex;
    if (typeof index !== 'number' || !Number.isInteger(index) || byIndex.has(index)) continue;
    const text = cleanLine(item?.text);
    if (text) byIndex.set(index, text);
  }
  const offerTexts = offers.map((offer, index) => {
    const text = byIndex.get(index);
    const valid =
      !!text &&
      lineCitesOffer(text, offer) &&
      lineCitesPrice(text, offer.price) &&
      estimateSpeechSecondsRaw(text) <= ctx.maxChunkS;
    return valid ? (text as string) : buildOfferLineText(offer);
  });
  const texts = fitCarouselTexts(
    {
      opening: cleanLine(raw?.opening) || CAROUSEL_OPENING_DEFAULT,
      offers: offerTexts,
      closing: cleanLine(raw?.closing) || CAROUSEL_CLOSING_DEFAULT,
    },
    offers,
  );
  const { scenes, lines } = buildCarouselScenes(texts, offers, idFactory);
  const endcard = buildEndcard(ctx.storeName);
  return {
    version: 1,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    format: opts.format,
    offers: offers.map((o) => ({ ...o })),
    products: offers.map((o) => ({ ...o })),
    environments: [],
    scenes,
    seal: null,
    endcard: endcard ?? null,
    lines,
    layoutPreset: ctx.layoutPreset,
    captions: ctx.captions,
  };
}

// ───────────── peça de ofertas configurável (change video-peca-configuravel) ─────────────

/**
 * Contexto do diretor da peça: o do F2 (ofertas FALADAS na ordem da peça,
 * loja, limite do motor) mais o que a peça fixa para o vídeo — a janela do
 * personagem (rect do bloco, frações do quadro), o modo rosto do logo, a cor
 * do painel (fundo do tile de fala) e a validade do rodapé para o fechamento.
 */
export interface DirectorPieceContext extends DirectorF2Context {
  window: { x: number; y: number; w: number; h: number };
  logoFace: boolean;
  talkBackgroundColor: string | null;
  closingHint: string | null;
}

/** Roteiro da peça: as falas do F2 (≥ 1 oferta) + janela, rosto do logo e cor do painel. */
export function buildOfferPieceScript(
  raw: RawDirectorF2,
  ctx: DirectorPieceContext,
  idFactory: () => string,
): McScript {
  const base = buildCarouselLikeScript(raw, ctx, idFactory, {
    format: 'offer_piece',
    minOffers: MC_OFFER_PIECE_MIN_OFFERS,
    label: '"peça de ofertas"',
  });
  return {
    ...base,
    window: { ...ctx.window },
    logoFace: ctx.logoFace,
    talkBackgroundColor: ctx.talkBackgroundColor,
  };
}

/** Falas MOCK da peça: as do F2, com a validade no fechamento quando o rodapé a traz. */
export function buildMockDirectorPiece(ctx: DirectorPieceContext): RawDirectorF2 {
  const base = buildMockDirectorF2(ctx);
  return ctx.closingHint ? { ...base, closing: `Válido ${ctx.closingHint}. Aproveite!` } : base;
}

export function buildMockScriptPiece(ctx: DirectorPieceContext, idFactory: () => string): McScript {
  return buildOfferPieceScript(buildMockDirectorPiece(ctx), ctx, idFactory);
}

/** Falas MOCK do F2 (MC_SCRIPT_PROVIDER=mock): determinísticas, preço por extenso, ≤ 30 s estimado. */
export function buildMockDirectorF2(
  ctx: Pick<DirectorF2Context, 'offers' | 'storeName'>,
): RawDirectorF2 {
  const store = ctx.storeName?.trim();
  return {
    opening: store ? `Olá! Confira as ofertas de hoje no ${store}.` : CAROUSEL_OPENING_DEFAULT,
    offerLines: ctx.offers.map((offer, offerIndex) => ({
      offerIndex,
      text: buildOfferLineText(offer),
    })),
    closing: CAROUSEL_CLOSING_DEFAULT,
  };
}

/** Roteiro MOCK F2: abertura + uma fala determinística por oferta + fechamento. */
export function buildMockScriptF2(ctx: DirectorF2Context, idFactory: () => string): McScript {
  return buildOfferCarouselScript(buildMockDirectorF2(ctx), ctx, idFactory);
}

/** Mesmo preço? ("24,9" = "24,90" = "R$ 24,90"); ilegível compara o texto. */
export function samePrice(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = parsePreco(a ?? '');
  const pb = parsePreco(b ?? '');
  if (pa && pb) return pa.reais === pb.reais && pa.centavos === pb.centavos;
  return (a ?? '').trim() === (b ?? '').trim();
}

export interface McOfferLineRewrite {
  sceneId: string;
  offerId: string;
  previousDialogue: string | null;
  proposedDialogue: string;
}

/**
 * F2 (tarefa 6.8, spec "Correção por tipo de mudança"): oferta cujo NOME ou
 * PREÇO ATUAL mudou em relação ao roteiro anterior e cuja fala NÃO foi
 * editada nesta mesma alteração → a fala é reescrita pelo line builder
 * (`buildOfferLineText`) e volta para confirmação na revisão do roteiro; só
 * o TTS e o clipe dela são refeitos (as outras falas mantêm o hash). Fala
 * editada junto pelo usuário é respeitada. Outros formatos: nada muda.
 */
export function rewriteSpokenOfferLines(
  previous: McScript | null | undefined,
  next: McScript,
): { script: McScript; rewritten: McOfferLineRewrite[] } {
  if (!previous || next.format !== 'offer_carousel') return { script: next, rewritten: [] };
  const before = new Map(
    (previous.offers ?? previous.products ?? []).map((o) => [o.id as string, o]),
  );
  const prevScenes = new Map(previous.scenes.map((s) => [s.sceneId as string, s]));
  const rewritten: McOfferLineRewrite[] = [];
  const scenes = next.scenes.map((scene) => {
    if (!scene.productRef) return scene;
    const offer = (next.offers ?? next.products ?? []).find((o) => o.id === scene.productRef);
    const old = before.get(scene.productRef);
    if (!offer || !old) return scene;
    const spokenChanged =
      offer.name.trim() !== old.name.trim() || !samePrice(offer.price, old.price);
    if (!spokenChanged) return scene;
    const prevDialogue = prevScenes.get(scene.sceneId as string)?.dialogue ?? null;
    const untouched =
      (prevDialogue ?? '').replace(/\s+/g, ' ').trim() ===
      (scene.dialogue ?? '').replace(/\s+/g, ' ').trim();
    if (!untouched) return scene;
    const proposed = buildOfferLineText(offer);
    rewritten.push({
      sceneId: scene.sceneId as string,
      offerId: offer.id as string,
      previousDialogue: prevDialogue,
      proposedDialogue: proposed,
    });
    return { ...scene, dialogue: proposed, durationS: plannedTalkDurationS(proposed) };
  });
  return { script: { ...next, scenes }, rewritten };
}
