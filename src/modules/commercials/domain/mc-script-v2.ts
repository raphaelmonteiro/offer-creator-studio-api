import { createHash } from 'crypto';
import { legacySceneType, isSceneType, sceneTypeDialogueIssue } from './mc-execution-plan';
import { MC_SCRIPT_SCHEMA_V2 } from './mc-quality';
import {
  MC_MAX_SEAL_PRODUCTS,
  MC_SAFE_AREAS,
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
  message: string;
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

/**
 * Validação do roteiro v2 antes de preparar/aprovar. Devolve TODOS os
 * problemas (a UI mostra por cena) em vez de lançar no primeiro.
 */
export function validateScriptV2(script: McScript): McScriptIssue[] {
  const issues: McScriptIssue[] = [];
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
  if ((script.products ?? []).length > MC_MAX_SEAL_PRODUCTS) {
    issues.push({
      code: 'TOO_MANY_PRODUCTS',
      message: `Máximo de ${MC_MAX_SEAL_PRODUCTS} produtos.`,
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
  return {
    ...script,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    products,
    scenes,
    seal: null,
  };
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
    JSON.stringify(previous.products ?? []) !== JSON.stringify(next.products ?? []);
  return (
    diffs.some((d) => d.compositionOnlyChanged || d.orderChanged) ||
    productsChanged ||
    options.endcardChanged === true
  );
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
