import { createHash } from 'crypto';
import { computeContentHash } from './input-hash';
import { legacySceneType, isSceneType, sceneTypeDialogueIssue } from './mc-execution-plan';
import { MC_PIECE_MAX_SPOKEN } from './mc-piece';
import { parsePreco } from './mc-preco-extenso';
import { MC_SCRIPT_SCHEMA_V2 } from './mc-quality';
import { MC_COMPOSITION_DIMENSIONS } from './mc-composition.config';
import { isWindowWellFormed, validateCharacterWindow } from './mc-talking-art-window';
import {
  isCarouselLayoutPreset,
  McAspectRatio,
  McCarouselLine,
  MC_MAX_SEAL_PRODUCTS,
  MC_OFFER_CAROUSEL_MAX_OFFERS,
  MC_OFFER_CAROUSEL_MAX_SPEECH_S,
  MC_OFFER_CAROUSEL_MIN_OFFERS,
  MC_SAFE_AREAS,
  MC_TALKING_ART_MAX_CITED_OFFERS,
  MC_TALKING_ART_MAX_OFFERS,
  MC_TALKING_ART_MAX_SCENES,
  McProjectFormat,
  McSceneType,
  McScript,
  McScriptScene,
  McSealCue,
  McSealProduct,
  sealProducts,
} from './mc-types';

/**
 * Roteiro do pipeline v2 (ADR-001 §3.2/§3.6/§4) — funções PURAS:
 * leitura tolerante do legado, conversão explícita, validação, derivação
 * PT→EN por hash da intenção e selos por associação explícita.
 *
 * Regras que este arquivo sustenta:
 * - `schemaVersion === 2` identifica o formato novo; `script.version` é
 *   editorial e NUNCA é usado para inferir schema.
 * - `sceneId` é a identidade; `idx` é só ordem de montagem.
 * - A derivação EN só vale se `derived.sourceHash` bate com o hash atual da
 *   intenção em pt — editar o pt invalida por construção (nada preservado por
 *   posição).
 * - Produto por cena vem de `productRef` → `script.products[].id`; sem
 *   rotação automática.
 */

export interface McScriptIssue {
  code: string;
  sceneId?: string;
  /** Elemento recusado (ex.: `character_window` — "apontando o elemento", D13). */
  element?: string;
  message: string;
}

/**
 * Quadro e tile para validar a janela do F1 contra a área segura e o aspecto
 * do tile (tarefa 4.7). Ausentes = a janela só é checada quanto à forma.
 */
export interface McScriptWindowContext {
  /** Aspecto de saída do projeto (define o tamanho e a área segura). */
  aspectRatio?: string | null;
  /** Razão largura/altura do tile do kit (trava o aspecto da janela, ±2%). */
  tileRatio?: number | null;
}

export function isScriptV2(script: Pick<McScript, 'schemaVersion'> | null | undefined): boolean {
  return script?.schemaVersion === MC_SCRIPT_SCHEMA_V2;
}

/** Texto canônico (trim + espaços colapsados) — mesma regra do input-hash. */
function canon(text: string | null | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ');
}

/** Hash da INTENÇÃO editorial (pt) que uma derivação EN representa. */
export function sceneSourceHash(
  scene: Pick<McScriptScene, 'initialFrame' | 'actionPrompt'>,
): string {
  return createHash('sha256')
    .update(`initialFrame=${canon(scene.initialFrame)}\nactionPrompt=${canon(scene.actionPrompt)}`)
    .digest('hex');
}

export type McDerivationState = 'ready' | 'pending';

export function derivationState(scene: McScriptScene): McDerivationState {
  const derived = scene.derived;
  if (!derived) return 'pending';
  return derived.sourceHash === sceneSourceHash(scene) ? 'ready' : 'pending';
}

export interface McEffectivePrompts {
  initialFrame: string;
  motion: string;
  lang: 'en' | 'pt';
  provider: string;
}

/**
 * Prompts EFETIVOS (o que vai para os motores): a derivação válida (EN ou
 * fallback PT explícito). `null` = derivação pendente — o chamador precisa
 * traduzir antes de gerar; nunca usar EN de outra revisão.
 */
export function effectiveScenePrompts(scene: McScriptScene): McEffectivePrompts | null {
  if (derivationState(scene) !== 'ready' || !scene.derived) return null;
  const d = scene.derived;
  if (d.lang === 'en') {
    return {
      initialFrame:
        canon(d.initialFrameEn) || canon(scene.initialFrame) || canon(scene.actionPrompt),
      motion: canon(d.actionPromptEn) || canon(scene.actionPrompt),
      lang: 'en',
      provider: d.provider,
    };
  }
  return {
    initialFrame: canon(scene.initialFrame) || canon(scene.actionPrompt),
    motion: canon(scene.actionPrompt),
    lang: 'pt',
    provider: d.provider,
  };
}

/** Selo default (ADR §3.6): sem alinhamento com a fala, segunda metade da cena. */
export function defaultSealCue(durationS: number): McSealCue {
  return { startS: Number((durationS / 2).toFixed(2)), endS: durationS };
}

export function scriptSceneById(script: McScript, sceneId: string): McScriptScene | null {
  return script.scenes.find((s) => s.sceneId === sceneId) ?? null;
}

export function productById(script: McScript, productId: string | null | undefined) {
  if (!productId) return null;
  return (script.products ?? []).find((p) => p.id === productId) ?? null;
}

/** Tipos de cena admitidos por formato (D6): F3 = cenas geradas; F1/F2 = só falas do tile. */
export const MC_SCENE_TYPES_BY_FORMAT: Record<McProjectFormat, readonly McSceneType[]> = {
  scenes: ['presenter', 'action', 'action_voiceover'],
  talking_art: ['talk_tile'],
  offer_carousel: ['talk_tile'],
  offer_piece: ['talk_tile'],
};

/**
 * Validação do roteiro v2 antes de preparar/aprovar. Devolve TODOS os
 * problemas (a UI mostra por cena) em vez de lançar no primeiro.
 * FORMAT-AWARE (D6): `opts.format` (default `scenes` — chamadores legados
 * mantêm o comportamento) decide os tipos de cena admissíveis; os campos do
 * F1 (narração, janela, ofertas citadas) são checados quando o roteiro se
 * declara `talking_art`.
 */
export function validateScriptV2(
  script: McScript,
  opts: { format?: McProjectFormat | null } & McScriptWindowContext = {},
): McScriptIssue[] {
  const issues: McScriptIssue[] = [];
  const format: McProjectFormat = opts.format ?? 'scenes';
  const allowedTypes = MC_SCENE_TYPES_BY_FORMAT[format] ?? MC_SCENE_TYPES_BY_FORMAT.scenes;
  if (!isScriptV2(script)) {
    issues.push({
      code: 'SCRIPT_NOT_V2',
      message: 'O roteiro não está no formato do pipeline v2.',
    });
    return issues;
  }
  if (!Array.isArray(script.scenes) || script.scenes.length === 0) {
    issues.push({ code: 'SCRIPT_EMPTY', message: 'O roteiro não tem cenas.' });
    return issues;
  }
  const productIds = new Set<string>();
  for (const product of script.products ?? []) {
    if (!product.id) {
      issues.push({ code: 'PRODUCT_WITHOUT_ID', message: `Produto "${product.name}" sem chave.` });
      continue;
    }
    if (productIds.has(product.id)) {
      issues.push({ code: 'PRODUCT_DUPLICATE_ID', message: `Produto duplicado: ${product.id}.` });
    }
    productIds.add(product.id);
    if (!product.name?.trim() || !product.price?.trim()) {
      issues.push({
        code: 'PRODUCT_INCOMPLETE',
        message: `Produto ${product.id} precisa de nome e preço.`,
      });
    }
  }
  // Teto de produtos por formato: selos do F3 (6); o F1 congela as ofertas da arte (12); o F2
  // anuncia de 3 a 6 (os limites próprios ficam em `validateOfferCarouselFields`).
  const maxProducts = MC_MAX_PRODUCTS_BY_FORMAT[format] ?? MC_MAX_SEAL_PRODUCTS;
  if ((script.products ?? []).length > maxProducts) {
    issues.push({
      code: 'TOO_MANY_PRODUCTS',
      message: `Máximo de ${maxProducts} produtos.`,
    });
  }
  const environmentIds = new Set((script.environments ?? []).map((e) => e.id));
  const seen = new Set<string>();
  script.scenes.forEach((scene, position) => {
    const sceneId = scene.sceneId;
    if (!sceneId) {
      issues.push({ code: 'SCENE_WITHOUT_ID', message: `Cena ${position + 1} sem identidade.` });
      return;
    }
    if (seen.has(sceneId)) {
      issues.push({ code: 'SCENE_DUPLICATE_ID', sceneId, message: `Cena ${sceneId} duplicada.` });
    }
    seen.add(sceneId);
    if (scene.idx !== position) {
      issues.push({
        code: 'SCENE_IDX_MISMATCH',
        sceneId,
        message: `Cena ${sceneId}: idx ${scene.idx} não corresponde à posição ${position}.`,
      });
    }
    if (!isSceneType(scene.sceneType)) {
      issues.push({
        code: 'SCENE_TYPE_INVALID',
        sceneId,
        message: `Cena ${sceneId}: tipo inválido.`,
      });
    } else {
      if (!allowedTypes.includes(scene.sceneType)) {
        issues.push({
          code: 'SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT',
          sceneId,
          message:
            scene.sceneType === 'talk_tile'
              ? `Cena ${position + 1}: o tipo "fala do tile" só existe nos formatos arte que fala e ofertas em sequência.`
              : `Cena ${position + 1}: cenas geradas (${scene.sceneType}) não existem no formato "${format}" — toda cena é uma fala do tile.`,
        });
      }
      const dialogueIssue = sceneTypeDialogueIssue(scene.sceneType, scene.dialogue);
      if (dialogueIssue) {
        issues.push({ code: 'SCENE_DIALOGUE_TYPE', sceneId, message: dialogueIssue });
      }
    }
    // talk_tile (D6/D7): a imagem é o tile do kit — não há keyframe, e o
    // `actionPrompt` é só um gesto OPCIONAL enviado ao motor de fala.
    if (scene.sceneType !== 'talk_tile' && !canon(scene.actionPrompt)) {
      issues.push({ code: 'SCENE_WITHOUT_ACTION', sceneId, message: `Cena ${sceneId} sem ação.` });
    }
    if (!Number.isFinite(scene.durationS) || scene.durationS <= 0) {
      issues.push({
        code: 'SCENE_DURATION',
        sceneId,
        message: `Cena ${sceneId}: duração inválida.`,
      });
    }
    if (scene.productRef !== null && scene.productRef !== undefined) {
      if (!productIds.has(scene.productRef)) {
        issues.push({
          code: 'PRODUCT_REF_UNKNOWN',
          sceneId,
          message: `Cena ${sceneId} aponta para um produto que não existe no roteiro.`,
        });
      }
    } else if (scene.productRef === undefined) {
      issues.push({
        code: 'PRODUCT_REF_MISSING',
        sceneId,
        message: `Cena ${sceneId}: informe o produto anunciado ou marque "sem oferta".`,
      });
    }
    if (scene.sealCue) {
      const { startS, endS } = scene.sealCue;
      if (!(startS >= 0 && endS > startS && endS <= scene.durationS + 0.01)) {
        issues.push({
          code: 'SEAL_CUE_RANGE',
          sceneId,
          message: `Cena ${sceneId}: intervalo do selo fora da duração da cena.`,
        });
      }
    }
    if (scene.safeArea && !(MC_SAFE_AREAS as readonly string[]).includes(scene.safeArea)) {
      issues.push({
        code: 'SAFE_AREA_INVALID',
        sceneId,
        message: `Cena ${sceneId}: área segura inválida.`,
      });
    }
    if (scene.environmentId && !environmentIds.has(scene.environmentId)) {
      issues.push({
        code: 'ENVIRONMENT_UNKNOWN',
        sceneId,
        message: `Cena ${sceneId} aponta para um cenário que não existe.`,
      });
    }
  });
  issues.push(...validateTalkingArtFields(script, productIds, opts));
  issues.push(...validateOfferCarouselFields(script));
  return issues;
}

/** Teto de `products[]` por formato (o F2 congela as ofertas escolhidas: 3 a 6). */
export const MC_MAX_PRODUCTS_BY_FORMAT: Record<McProjectFormat, number> = {
  scenes: MC_MAX_SEAL_PRODUCTS,
  talking_art: MC_TALKING_ART_MAX_OFFERS,
  offer_carousel: MC_OFFER_CAROUSEL_MAX_OFFERS,
  // peça de ofertas: `products[]` do roteiro são só os itens FALADOS (até 6)
  offer_piece: MC_PIECE_MAX_SPOKEN,
};

/**
 * Campos do formato F1 "arte que fala" (change video-formatos-personagem, D6):
 * narração presente, janela em frações 0..1 inteira no quadro, `logoFace`
 * booleano, ofertas citadas ⊆ produtos (≤ 3, sem repetição) e cenas SÓ do
 * tipo `talk_tile` (1 a 3 — cada frase da narração vira uma fala).
 */
export function validateTalkingArtFields(
  script: McScript,
  productIds: Set<string> = new Set((script.products ?? []).map((p) => p.id as string)),
  windowContext: McScriptWindowContext = {},
): McScriptIssue[] {
  const issues: McScriptIssue[] = [];
  if (script.format !== 'talking_art') return issues;
  if (!canon(script.narration)) {
    issues.push({
      code: 'NARRATION_MISSING',
      message: 'O roteiro "arte que fala" precisa do texto da apresentação.',
    });
  }
  if (!isWindowWellFormed(script.window)) {
    issues.push({
      code: 'WINDOW_INVALID',
      message:
        'A janela do personagem precisa de x, y, w e h em frações de 0 a 1, com tamanho positivo e inteira dentro do quadro.',
    });
  } else {
    // Tarefa 4.7: área segura do tamanho de saída + aspecto do tile, quando o
    // chamador informa o quadro (WINDOW_OUTSIDE_SAFE_AREA / WINDOW_ASPECT_MISMATCH).
    const frame = windowContext.aspectRatio
      ? MC_COMPOSITION_DIMENSIONS[windowContext.aspectRatio as McAspectRatio]
      : undefined;
    if (frame) {
      for (const issue of validateCharacterWindow({
        window: script.window,
        width: frame.width,
        height: frame.height,
        tileRatio: windowContext.tileRatio ?? null,
        logoFace: script.logoFace === true,
      })) {
        issues.push({ code: issue.code, element: issue.element, message: issue.message });
      }
    }
  }
  if (script.logoFace !== undefined && typeof script.logoFace !== 'boolean') {
    issues.push({
      code: 'LOGO_FACE_INVALID',
      message: 'logoFace precisa ser verdadeiro ou falso.',
    });
  }
  const cited = script.citedOfferIds ?? [];
  if (!Array.isArray(cited)) {
    issues.push({ code: 'CITED_OFFERS_INVALID', message: 'citedOfferIds precisa ser uma lista.' });
  } else {
    if (cited.length > MC_TALKING_ART_MAX_CITED_OFFERS) {
      issues.push({
        code: 'CITED_OFFERS_TOO_MANY',
        message: `No máximo ${MC_TALKING_ART_MAX_CITED_OFFERS} ofertas citadas na fala.`,
      });
    }
    if (new Set(cited).size !== cited.length) {
      issues.push({ code: 'CITED_OFFER_DUPLICATE', message: 'Oferta citada repetida.' });
    }
    for (const id of cited) {
      if (!productIds.has(id)) {
        issues.push({
          code: 'CITED_OFFER_UNKNOWN',
          message: `A oferta citada ${id} não existe nos produtos do roteiro.`,
        });
      }
    }
  }
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  if (scenes.length > MC_TALKING_ART_MAX_SCENES) {
    issues.push({
      code: 'TOO_MANY_TALK_SCENES',
      message: `A apresentação é dividida em no máximo ${MC_TALKING_ART_MAX_SCENES} falas.`,
    });
  }
  return issues;
}

// ───────────────── F2 "ofertas em sequência" (tarefa 6.6) ─────────────────

/** Ofertas do roteiro F2 (`offers[]`; roteiros sem o campo caem em `products[]`). */
export function carouselOffers(script: Pick<McScript, 'offers' | 'products'>): McSealProduct[] {
  return script.offers ?? script.products ?? [];
}

/**
 * Falas do F2 derivadas das CENAS (fonte única do texto e da ordem): a
 * primeira é a abertura, a última o fechamento e as do meio, uma por oferta,
 * com `offerRef = productRef` da cena. Reordenar cenas reordena as falas.
 */
export function deriveCarouselLines(scenes: McScriptScene[]): McCarouselLine[] {
  const last = scenes.length - 1;
  return scenes.map((scene, position) => {
    const kind = position === 0 ? 'opening' : position === last ? 'closing' : 'offer';
    return {
      sceneId: scene.sceneId as string,
      kind,
      offerRef: scene.productRef ?? null,
    };
  });
}

/**
 * Normalização do roteiro F2: falas derivadas das cenas; `offers[]` na ordem
 * das falas de oferta (ofertas sem fala vão para o fim — a validação aponta);
 * `products[]` vira o espelho de `offers[]` (mesmos ids, mesma ordem).
 * Roteiros de outros formatos voltam intactos.
 */
export function normalizeOfferCarouselScript(script: McScript): McScript {
  if (script.format !== 'offer_carousel') return script;
  const lines = deriveCarouselLines(script.scenes);
  const offers = carouselOffers(script);
  const order = lines.filter((l) => l.kind === 'offer' && l.offerRef).map((l) => l.offerRef);
  const ranked = [
    ...order
      .map((id) => offers.find((o) => o.id === id))
      .filter((o, i, all): o is McSealProduct => !!o && all.indexOf(o) === i),
    ...offers.filter((o) => !order.includes(o.id as string)),
  ];
  return {
    ...script,
    offers: ranked.map((o) => ({ ...o })),
    products: ranked.map((o) => ({ ...o })),
    lines,
  };
}

/**
 * Campos do formato F2 (D6/D8, spec video-offer-carousel): 3 a 6 ofertas
 * congeladas, cada uma com nome, preço legível e foto; `products[]` espelho de
 * `offers[]`; falas = abertura + uma por oferta NA ORDEM das ofertas +
 * fechamento, cada fala uma cena `talk_tile` com `productRef = offerRef`;
 * preset de layout conhecido e `captions` booleano.
 */
export function validateOfferCarouselFields(script: McScript): McScriptIssue[] {
  const issues: McScriptIssue[] = [];
  if (script.format !== 'offer_carousel') return issues;
  const offers = carouselOffers(script);
  if (offers.length < MC_OFFER_CAROUSEL_MIN_OFFERS) {
    issues.push({
      code: 'OFFERS_TOO_FEW',
      element: 'offers',
      message: `"Ofertas em sequência" precisa de no mínimo ${MC_OFFER_CAROUSEL_MIN_OFFERS} ofertas.`,
    });
  }
  if (offers.length > MC_OFFER_CAROUSEL_MAX_OFFERS) {
    issues.push({
      code: 'OFFERS_TOO_MANY',
      element: 'offers',
      message:
        `"Ofertas em sequência" aceita no máximo ${MC_OFFER_CAROUSEL_MAX_OFFERS} ofertas ` +
        `(o vídeo tem até ${MC_OFFER_CAROUSEL_MAX_SPEECH_S} s de fala).`,
    });
  }
  offers.forEach((offer, position) => {
    const label = `Oferta ${position + 1}${offer.name?.trim() ? ` ("${offer.name.trim()}")` : ''}`;
    if (!offer.id) {
      issues.push({ code: 'OFFER_WITHOUT_ID', element: 'offer', message: `${label} sem chave.` });
    }
    if (!offer.imageUrl?.trim()) {
      issues.push({
        code: 'OFFER_IMAGE_REQUIRED',
        element: 'offer',
        message: `${label} precisa de foto (catálogo ou galeria).`,
      });
    }
    if (offer.price?.trim() && !parsePreco(offer.price)) {
      issues.push({
        code: 'OFFER_PRICE_INVALID',
        element: 'offer',
        message: `${label}: preço "${offer.price}" ilegível (use o formato 24,90).`,
      });
    }
    if (offer.originalPrice?.trim() && !parsePreco(offer.originalPrice)) {
      issues.push({
        code: 'OFFER_PRICE_INVALID',
        element: 'offer',
        message: `${label}: preço anterior "${offer.originalPrice}" ilegível.`,
      });
    }
  });
  const productIds = (script.products ?? []).map((p) => p.id ?? '');
  if (productIds.join('\u0000') !== offers.map((o) => o.id ?? '').join('\u0000')) {
    issues.push({
      code: 'OFFERS_PRODUCTS_MISMATCH',
      element: 'offers',
      message: 'As ofertas e os produtos do roteiro divergem (products[] espelha offers[]).',
    });
  }
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const lines = script.lines ?? [];
  const expectedLines = offers.length + 2;
  if (scenes.length !== expectedLines || lines.length !== scenes.length) {
    issues.push({
      code: 'CAROUSEL_LINES_COUNT',
      element: 'lines',
      message:
        `O roteiro precisa de ${expectedLines} falas: abertura, uma por oferta ` +
        `(${offers.length}) e fechamento — tem ${scenes.length}.`,
    });
  }
  lines.forEach((line, position) => {
    const scene = scenes[position];
    const sceneId = scene?.sceneId;
    if (!scene || line.sceneId !== sceneId) {
      issues.push({
        code: 'CAROUSEL_LINE_SCENE_MISMATCH',
        element: 'lines',
        message: `A fala ${position + 1} não corresponde à cena ${position + 1} do roteiro.`,
      });
      return;
    }
    const expectedKind =
      position === 0 ? 'opening' : position === lines.length - 1 ? 'closing' : 'offer';
    if (line.kind !== expectedKind) {
      issues.push({
        code: 'CAROUSEL_LINE_KIND',
        sceneId,
        element: 'lines',
        message:
          expectedKind === 'offer'
            ? `Fala ${position + 1}: entre a abertura e o fechamento, cada fala apresenta uma oferta.`
            : `Fala ${position + 1}: a primeira fala é a abertura e a última o fechamento.`,
      });
    }
    if (line.kind === 'offer' && !line.offerRef) {
      issues.push({
        code: 'CAROUSEL_LINE_OFFER_MISSING',
        sceneId,
        element: 'lines',
        message: `Fala ${position + 1}: vincule a fala à sua oferta.`,
      });
    }
    if (line.kind !== 'offer' && line.offerRef) {
      issues.push({
        code: 'CAROUSEL_LINE_OFFER_MISMATCH',
        sceneId,
        element: 'lines',
        message: `Fala ${position + 1}: a abertura e o fechamento não apresentam oferta.`,
      });
    }
    if ((scene.productRef ?? null) !== (line.offerRef ?? null)) {
      issues.push({
        code: 'CAROUSEL_LINE_OFFER_MISMATCH',
        sceneId,
        element: 'lines',
        message: `Fala ${position + 1}: a oferta da fala difere da oferta da cena.`,
      });
    }
  });
  const offerLineRefs = lines.filter((l) => l.kind === 'offer').map((l) => l.offerRef ?? '');
  if (
    lines.length > 0 &&
    offerLineRefs.join('\u0000') !== offers.map((o) => o.id ?? '').join('\u0000')
  ) {
    issues.push({
      code: 'CAROUSEL_LINES_OFFER_ORDER',
      element: 'lines',
      message: 'Precisa haver exatamente uma fala por oferta, na ordem das ofertas.',
    });
  }
  if (script.layoutPreset !== undefined && !isCarouselLayoutPreset(script.layoutPreset)) {
    issues.push({
      code: 'LAYOUT_PRESET_INVALID',
      element: 'layout',
      message: `Preset de layout desconhecido: "${String(script.layoutPreset)}".`,
    });
  }
  if (script.captions !== undefined && typeof script.captions !== 'boolean') {
    issues.push({
      code: 'CAPTIONS_INVALID',
      element: 'captions',
      message: 'captions precisa ser verdadeiro ou falso.',
    });
  }
  return issues;
}

/**
 * Normalização de um roteiro v2 recebido (DTO/LLM): reindexa por posição,
 * gera `sceneId` para cenas sem identidade, aplica tipo default pela fala
 * (só para cenas SEM tipo — nunca sobrescreve) e `productRef` undefined → null
 * quando não há produtos (sem produtos não existe ambiguidade).
 */
export function normalizeScriptV2(
  script: McScript,
  idFactory: () => string,
  opts: { defaultProductRef?: boolean } = {},
): McScript {
  const products = (script.products ?? []).map((p) => ({
    ...p,
    id: p.id ?? idFactory(),
    name: p.name.trim(),
    price: p.price.trim(),
  }));
  const hasProducts = products.length > 0;
  const scenes = script.scenes.map((scene, position) => {
    const sceneType = isSceneType(scene.sceneType)
      ? scene.sceneType
      : legacySceneType(scene.dialogue);
    const productRef =
      scene.productRef === undefined
        ? hasProducts && opts.defaultProductRef !== true
          ? undefined
          : null
        : scene.productRef;
    return {
      ...scene,
      idx: position,
      sceneId: scene.sceneId ?? idFactory(),
      sceneType,
      initialFrame: scene.initialFrame?.trim() || undefined,
      dialogue: scene.dialogue?.trim() ? scene.dialogue.trim() : null,
      ...(productRef === undefined ? {} : { productRef }),
    };
  });
  return normalizeOfferCarouselScript({
    ...script,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    products,
    ...(script.offers
      ? {
          offers: script.offers.map((o) => ({
            ...o,
            id: o.id ?? idFactory(),
            name: o.name.trim(),
            price: o.price.trim(),
          })),
        }
      : {}),
    scenes,
    seal: null,
  });
}

/**
 * Conversão EXPLÍCITA de roteiro legado → v2 (ADR §5): cria identidades,
 * tipo pela interpretação histórica (falada = presenter) e snapshot de
 * produtos a partir do selo. A associação produto×cena do legado era rotação
 * por posição; a conversão reproduz essa associação para preservar o que o
 * usuário via, mas marca `productRefsInferred` para a UI pedir confirmação
 * antes da aprovação.
 */
export function convertLegacyScript(
  script: McScript,
  idFactory: () => string,
): { script: McScript; productRefsInferred: boolean } {
  if (isScriptV2(script)) return { script, productRefsInferred: false };
  const products: McSealProduct[] = sealProducts(script.seal).map((p) => ({
    id: idFactory(),
    catalogId: p.catalogId ?? null,
    unit: p.unit ?? null,
    imageUrl: p.imageUrl ?? null,
    name: p.name,
    price: p.price,
  }));
  const scenes: McScriptScene[] = script.scenes.map((scene, position) => {
    const productRef = products.length > 0 ? products[position % products.length].id! : null;
    const legacyEn = scene.actionPromptEn?.trim();
    const converted: McScriptScene = {
      idx: position,
      sceneId: idFactory(),
      sceneType: legacySceneType(scene.dialogue),
      initialFrame: undefined,
      camera: null,
      environmentId: null,
      productRef,
      sealCue: defaultSealCue(scene.durationS),
      safeArea: 'lower_third',
      actionPrompt: scene.actionPrompt,
      dialogue: scene.dialogue ?? null,
      durationS: scene.durationS,
    };
    // A EN legada vira derivação válida da MESMA intenção (hash calculado agora).
    if (legacyEn) {
      converted.derived = {
        sourceHash: sceneSourceHash(converted),
        initialFrameEn: null,
        actionPromptEn: legacyEn,
        lang: 'en',
        provider: 'legacy_script',
        at: new Date().toISOString(),
      };
    }
    return converted;
  });
  return {
    script: {
      version: script.version + 1,
      schemaVersion: MC_SCRIPT_SCHEMA_V2,
      products,
      environments: [],
      scenes,
      seal: null,
      endcard: script.endcard ?? null,
    },
    productRefsInferred: products.length > 0 && scenes.length > 0,
  };
}

/** Selo efetivo de uma cena v2: produto explícito do snapshot + intervalo (default = 2ª metade). */
export function sceneSeal(
  script: McScript,
  scene: McScriptScene,
): { product: McSealProduct; cue: McSealCue } | null {
  const product = productById(script, scene.productRef);
  if (!product) return null;
  return { product, cue: scene.sealCue ?? defaultSealCue(scene.durationS) };
}

/**
 * Diferença editorial entre duas versões do roteiro, por `sceneId` (ADR §4.2
 * matriz de invalidação): o que mudou em cada cena decide o que refazer.
 */
export interface McSceneDiff {
  sceneId: string;
  added: boolean;
  removed: boolean;
  intentChanged: boolean; // initialFrame/actionPrompt (visual + movimento)
  dialogueChanged: boolean;
  typeChanged: boolean;
  durationChanged: boolean;
  environmentChanged: boolean;
  /** Só selo/produto/intervalo/área segura — não toca mídia de IA. */
  compositionOnlyChanged: boolean;
  orderChanged: boolean;
}

export function diffScriptsV2(previous: McScript | null, next: McScript): McSceneDiff[] {
  const prevById = new Map((previous?.scenes ?? []).map((s) => [s.sceneId as string, s]));
  const nextById = new Map(next.scenes.map((s) => [s.sceneId as string, s]));
  const diffs: McSceneDiff[] = [];
  for (const scene of next.scenes) {
    const id = scene.sceneId as string;
    const before = prevById.get(id);
    if (!before) {
      diffs.push({
        sceneId: id,
        added: true,
        removed: false,
        intentChanged: true,
        dialogueChanged: true,
        typeChanged: true,
        durationChanged: true,
        environmentChanged: true,
        compositionOnlyChanged: false,
        orderChanged: false,
      });
      continue;
    }
    const intentChanged = sceneSourceHash(before) !== sceneSourceHash(scene);
    const dialogueChanged = canon(before.dialogue) !== canon(scene.dialogue);
    const typeChanged = before.sceneType !== scene.sceneType;
    const durationChanged = before.durationS !== scene.durationS;
    const environmentChanged = (before.environmentId ?? null) !== (scene.environmentId ?? null);
    const sealChanged =
      (before.productRef ?? null) !== (scene.productRef ?? null) ||
      JSON.stringify(before.sealCue ?? null) !== JSON.stringify(scene.sealCue ?? null) ||
      (before.safeArea ?? null) !== (scene.safeArea ?? null);
    diffs.push({
      sceneId: id,
      added: false,
      removed: false,
      intentChanged,
      dialogueChanged,
      typeChanged,
      durationChanged,
      environmentChanged,
      compositionOnlyChanged:
        sealChanged &&
        !intentChanged &&
        !dialogueChanged &&
        !typeChanged &&
        !durationChanged &&
        !environmentChanged,
      orderChanged: before.idx !== scene.idx,
    });
  }
  for (const [id] of prevById) {
    if (!nextById.has(id)) {
      diffs.push({
        sceneId: id,
        added: false,
        removed: true,
        intentChanged: false,
        dialogueChanged: false,
        typeChanged: false,
        durationChanged: false,
        environmentChanged: false,
        compositionOnlyChanged: false,
        orderChanged: false,
      });
    }
  }
  return diffs;
}

/** true quando a edição só toca composição (selo/cartela/ordem/produto) — rota `assembly_only`. */
export function isCompositionOnlyChange(
  previous: McScript,
  next: McScript,
  options: { endcardChanged?: boolean } = {},
): boolean {
  const diffs = diffScriptsV2(previous, next);
  if (diffs.some((d) => d.added || d.removed)) return false;
  const touchesMedia = diffs.some(
    (d) =>
      d.intentChanged ||
      d.dialogueChanged ||
      d.typeChanged ||
      d.durationChanged ||
      d.environmentChanged,
  );
  if (touchesMedia) return false;
  const productsChanged =
    JSON.stringify(canonicalProducts(previous.products)) !==
    JSON.stringify(canonicalProducts(next.products));
  return (
    diffs.some((d) => d.compositionOnlyChanged || d.orderChanged) ||
    productsChanged ||
    compositionFieldsChanged(previous, next) ||
    options.endcardChanged === true
  );
}

/** Campos de um produto/oferta como chegam de um DTO: opcionais `undefined` = "não mexer". */
export interface McProductPatch {
  id?: string;
  catalogId?: string | null;
  unit?: string | null;
  imageUrl?: string | null;
  name: string;
  price: string;
  originalPrice?: string | null;
  badge?: string | null;
}

/**
 * Produto do roteiro a partir do DTO PRESERVANDO o que o DTO omite (BUG B):
 * campo ausente (`undefined`) mantém o valor congelado da mesma oferta
 * (catálogo, unidade, foto, preço anterior, badge); `null` explícito limpa.
 */
export function mergeScriptProduct(
  patch: McProductPatch,
  known: McSealProduct | null | undefined,
  idFactory: () => string,
): McSealProduct {
  const pick = <K extends keyof McSealProduct>(key: K): McSealProduct[K] | null =>
    (patch as Partial<McSealProduct>)[key] !== undefined
      ? ((patch as Partial<McSealProduct>)[key] as McSealProduct[K])
      : ((known?.[key] ?? null) as McSealProduct[K] | null);
  return {
    id: patch.id ?? idFactory(),
    catalogId: pick('catalogId'),
    unit: pick('unit'),
    imageUrl: pick('imageUrl'),
    name: patch.name,
    price: patch.price,
    originalPrice: pick('originalPrice'),
    badge: pick('badge'),
  };
}

/**
 * Produto canônico para comparação: campos opcionais ausentes valem null —
 * `{originalPrice: undefined}` e `{originalPrice: null}` são a mesma oferta
 * (BUG B: um "salvar" sem mudança não pode parecer troca de produto).
 */
export function canonicalProduct(product: McSealProduct): Record<string, unknown> {
  return {
    id: product.id ?? null,
    catalogId: product.catalogId ?? null,
    name: (product.name ?? '').trim(),
    price: (product.price ?? '').trim(),
    originalPrice: product.originalPrice ?? null,
    unit: product.unit ?? null,
    badge: product.badge ?? null,
    imageUrl: product.imageUrl ?? null,
  };
}

export function canonicalProducts(
  products: McSealProduct[] | null | undefined,
): Array<Record<string, unknown>> {
  return (products ?? []).map(canonicalProduct);
}

/**
 * Campos de COMPOSIÇÃO dos formatos novos (não tocam TTS nem clipe — só
 * `compose_ffmpeg`/`render_remotion` + `finalize`): F1 janela, cor da janela e
 * rosto do logo; F2 preset de layout, legendas e ordem das falas.
 */
export function compositionFieldsChanged(previous: McScript, next: McScript): boolean {
  const pick = (s: McScript) =>
    JSON.stringify({
      window: s.window ?? null,
      logoFace: s.logoFace ?? null,
      talkBackgroundColor: s.talkBackgroundColor ?? null,
      layoutPreset: s.layoutPreset ?? null,
      captions: s.captions ?? null,
      lines: s.lines ?? null,
      offers: s.offers ? canonicalProducts(s.offers) : null,
    });
  return pick(previous) !== pick(next);
}

/**
 * Conteúdo editorial do roteiro (sem `version`, sem o carimbo das derivações),
 * com opcionais ausentes valendo null: dois roteiros com a mesma impressão
 * são o MESMO roteiro — o `updateScript` trata como "salvar sem mudança".
 */
export function scriptContentHash(script: McScript): string {
  const scenes = (script.scenes ?? []).map((scene) => ({
    sceneId: scene.sceneId ?? null,
    sceneType: scene.sceneType ?? null,
    initialFrame: canon(scene.initialFrame) || null,
    camera: scene.camera ?? null,
    environmentId: scene.environmentId ?? null,
    productRef: scene.productRef ?? null,
    sealCue: scene.sealCue ?? null,
    safeArea: scene.safeArea ?? null,
    actionPrompt: canon(scene.actionPrompt),
    dialogue: canon(scene.dialogue) || null,
    durationS: scene.durationS,
    derivedSourceHash: scene.derived?.sourceHash ?? null,
  }));
  return computeContentHash({
    schemaVersion: script.schemaVersion ?? null,
    format: script.format ?? null,
    products: canonicalProducts(script.products),
    offers: script.offers ? canonicalProducts(script.offers) : null,
    lines: script.lines ?? null,
    environments: (script.environments ?? []).map((e) => ({
      id: e.id,
      assetId: e.assetId ?? null,
      description: e.description,
      version: e.version ?? null,
    })),
    scenes,
    endcard: script.endcard?.storeName ?? null,
    narration: canon(script.narration) || null,
    window: script.window ?? null,
    logoFace: script.logoFace ?? null,
    citedOfferIds: script.citedOfferIds ?? null,
    talkBackgroundColor: script.talkBackgroundColor ?? null,
    layoutPreset: script.layoutPreset ?? null,
    captions: script.captions ?? null,
  });
}

/** Preço citado na fala mudou? (ADR §3.6: preço também falado exige revalidar o áudio.) */
export function dialogueMentionsPrice(dialogue: string | null | undefined): boolean {
  if (!dialogue) return false;
  return (
    /\b(reais?|centavos?|R\$|\d+[.,]\d{2})\b/i.test(dialogue) ||
    /\b(e (noventa|oitenta|setenta|sessenta|cinquenta|quarenta|trinta|vinte|dez|cinco|nove|oito|sete|seis|quatro|três|tres|dois|um)\b)/i.test(
      dialogue,
    )
  );
}
