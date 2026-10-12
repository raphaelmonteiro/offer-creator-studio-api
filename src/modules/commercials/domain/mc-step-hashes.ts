import { McVoiceDelivery, voiceDeliveryKey } from './mc-voice-delivery';
import { computeInputHash, MC_BUILDER_VERSIONS, MC_BUILDER_VERSIONS_V2 } from './input-hash';
import { McKitSource, McKitStyle } from './mc-kit-identity';
import { KLING_ACTION_MODEL, KLING_AVATAR_MODEL } from './mc-pipeline.config';
import { McPromptLang, McSelectedReference } from './mc-quality';
import { McScriptEndcard, McScriptSeal, McStepType } from './mc-types';

/**
 * Construção dos input_hash por tipo de step (plano-comerciais §6.3) — função
 * pura, fonte única da matriz de invalidação.
 *
 * LEGADO (pipelineVersion 1):
 * | Tipo     | Entra no hash                                   | NÃO entra    |
 * |----------|--------------------------------------------------|-------------|
 * | keyframe | actionPrompt, aspectRatio, kit(id+version)       | generation  |
 * | tts      | dialogue, voiceId, cadeia de modelos             | generation  |
 * | video    | keyframeHash, actionPrompt, durationS, generation| —           |
 * | lipsync  | keyframeHash, ttsHash, generation, modelo        | —           |
 * | assembly | [{idx, generation}] das cenas, selo, aspecto     | —           |
 *
 * PIPELINE V2 (ADR-001 §4.2): o hash representa a REQUISIÇÃO EFETIVA —
 * prompt resolvido e idioma, modelo/configuração, versão do builder,
 * assets de referência selecionados, cenário versionado, formato e a
 * TENTATIVA explícita (regenerar = attempt++ = hash novo; retry de transporte
 * da mesma tentativa = mesmo hash). Steps dependentes hasheiam o ASSET
 * selecionado (keyframe/áudio escolhidos na revisão), não o hash do step que
 * o produziu — trocar a prévia selecionada invalida os dependentes.
 */
export interface SceneHashContext {
  kitId: string;
  kitVersion: number;
  voiceId: string | null;
  aspectRatio: string;
  actionPrompt: string;
  dialogue: string | null;
  durationS: number;
  generation: number;
  /**
   * Estilo fixo do kit (D5): entra no keyframe só quando definido, para que
   * kits anteriores (style nulo) mantenham os hashes — "nada é regerado".
   */
  style?: McKitStyle | null;
}

/** Chave de estilo só quando há estilo: kit legado ⇒ hash idêntico ao de antes da change. */
function styleKey(style: McKitStyle | null | undefined): { style?: McKitStyle } {
  return style ? { style } : {};
}

/** Cadeia de TTS do módulo (plano §5.3): multilingual_v2 (obedece speed/style) com fallback eleven_v3. */
export const MC_TTS_MODEL_CHAIN = 'eleven_multilingual_v2|eleven_v3';

export interface SceneStepHashes {
  keyframe: string;
  tts: string | null;
  video: string;
  lipsync: string | null;
}

export function isSpokenScene(scene: { dialogue: string | null }): boolean {
  return scene.dialogue !== null && scene.dialogue !== undefined && scene.dialogue !== '';
}

export function computeSceneStepHashes(ctx: SceneHashContext): SceneStepHashes {
  const spoken = isSpokenScene(ctx);
  const keyframe = computeInputHash(McStepType.KEYFRAME, MC_BUILDER_VERSIONS.keyframe, {
    actionPrompt: ctx.actionPrompt,
    aspectRatio: ctx.aspectRatio,
    kitId: ctx.kitId,
    kitVersion: ctx.kitVersion,
    ...styleKey(ctx.style),
  });
  const tts = spoken
    ? computeInputHash(McStepType.TTS, MC_BUILDER_VERSIONS.tts, {
        dialogue: ctx.dialogue,
        voiceId: ctx.voiceId,
        modelChain: MC_TTS_MODEL_CHAIN,
      })
    : null;
  const video = computeInputHash(McStepType.VIDEO, MC_BUILDER_VERSIONS.video, {
    keyframeHash: keyframe,
    actionPrompt: ctx.actionPrompt,
    durationS: ctx.durationS,
    generation: ctx.generation,
    audioDriven: spoken,
  });
  const lipsync = spoken
    ? computeInputHash(McStepType.LIPSYNC, MC_BUILDER_VERSIONS.lipsync, {
        keyframeHash: keyframe,
        ttsHash: tts,
        generation: ctx.generation,
        model: KLING_AVATAR_MODEL,
      })
    : null;
  return { keyframe, tts, video, lipsync };
}

/**
 * Hash do assembly LEGADO: muda quando qualquer cena re-rola (generation) e
 * quando qualquer camada determinística muda — selo (texto OU produtos),
 * cartela final, formato e as opções de trilha/legenda. Re-montagem é step
 * novo (grátis, plano §6.3).
 */
export function computeAssemblyHash(
  scenes: Array<{ idx: number; generation: number }>,
  seal: McScriptSeal | null | undefined,
  aspectRatio: string,
  extra: {
    endcard?: McScriptEndcard | null;
    musicEnabled?: boolean;
    captionsEnabled?: boolean;
  } = {},
): string {
  return computeInputHash(McStepType.ASSEMBLY, MC_BUILDER_VERSIONS.assembly, {
    scenes: [...scenes]
      .sort((a, b) => a.idx - b.idx)
      .map((s) => ({ idx: s.idx, generation: s.generation })),
    seal: seal?.text ?? null,
    sealProducts: (seal?.products ?? []).map((p) => ({ name: p.name, price: p.price })),
    endcard: extra.endcard?.storeName ?? null,
    musicEnabled: extra.musicEnabled ?? true,
    captionsEnabled: extra.captionsEnabled ?? true,
    aspectRatio,
  });
}

// ─────────────────────────────── pipeline v2 ───────────────────────────────

/** Modelo do gerador de keyframe (entra no hash: trocar modelo invalida). */
export const MC_KEYFRAME_MODEL_V2 = 'nano-banana-pro-preview';
/** Versão do negative prompt do motor de ação (mudar o texto = bump aqui). */
export const MC_ACTION_NEGATIVE_PROMPT_VERSION = 1;
/** Política de áudio do scene_compose: o áudio original do clipe é descartado. */
export const MC_COMPOSE_AUDIO_POLICY = 'replace_clip_audio';

export interface KeyframeHashInputV2 {
  kitId: string;
  kitVersion: number;
  aspectRatio: string;
  initialFramePrompt: string;
  promptLang: McPromptLang;
  references: McSelectedReference[];
  environment: { id: string; version: number; assetId: string | null } | null;
  attempt: number;
  model?: string;
  /** Estilo fixo do kit (D5) — só entra quando definido (kit legado mantém o hash). */
  style?: McKitStyle | null;
}

export function computeKeyframeHashV2(input: KeyframeHashInputV2): string {
  return computeInputHash(McStepType.KEYFRAME, MC_BUILDER_VERSIONS_V2.keyframe, {
    kitId: input.kitId,
    kitVersion: input.kitVersion,
    aspectRatio: input.aspectRatio,
    prompt: input.initialFramePrompt,
    lang: input.promptLang,
    ...styleKey(input.style),
    references: input.references.map((r) => ({ assetId: r.assetId, role: r.role })),
    environment: input.environment
      ? {
          id: input.environment.id,
          version: input.environment.version,
          assetId: input.environment.assetId,
        }
      : null,
    model: input.model ?? MC_KEYFRAME_MODEL_V2,
    attempt: input.attempt,
  });
}

// ─────────────────────────── referências do kit ───────────────────────────

/** Versão do builder dos prompts de referência (kit-prompts.ts): bump quando o texto dos slots muda. */
export const MC_KIT_REFERENCE_BUILDER_VERSION = 1;

/**
 * Hash do kit (D1/D5): a REQUISIÇÃO efetiva de uma referência — imagem de
 * origem, slot, prompt resolvido (que já carrega o bloco de estilo e a cor de
 * fundo), e os próprios `style`/`backgroundColor`/`source` explícitos, para a
 * matriz de invalidação não depender do texto. Gravado no asset da referência.
 */
export interface KitReferenceHashInput {
  slot: number;
  prompt: string;
  /** sha256 da imagem enviada como referência (mascote, logo ou identidade escolhida). */
  sourceImageHash: string;
  source: McKitSource;
  style: McKitStyle | null;
  /** Cor de fundo efetiva do slot frontal (nome ou hex). */
  backgroundColor: string;
  model: string;
}

export function computeKitReferenceHash(input: KitReferenceHashInput): string {
  return computeInputHash('kit_reference', MC_KIT_REFERENCE_BUILDER_VERSION, {
    slot: input.slot,
    prompt: input.prompt,
    sourceImageHash: input.sourceImageHash,
    source: input.source,
    style: input.style,
    backgroundColor: input.backgroundColor,
    model: input.model,
  });
}

export interface TtsHashInputV2 {
  dialogue: string;
  voiceId: string | null;
  attempt: number;
  /** Perfil de entrega (velocidade/expressividade) — é input EFETIVO da fala. */
  delivery?: McVoiceDelivery | null;
}

export function computeTtsHashV2(input: TtsHashInputV2): string {
  return computeInputHash(McStepType.TTS, MC_BUILDER_VERSIONS_V2.tts, {
    dialogue: input.dialogue,
    voiceId: input.voiceId,
    modelChain: MC_TTS_MODEL_CHAIN,
    delivery: input.delivery ? voiceDeliveryKey(input.delivery) : null,
    attempt: input.attempt,
  });
}

export interface VideoHashInputV2 {
  /** Keyframe SELECIONADO na revisão (asset), não o hash do step. */
  keyframeAssetId: string;
  motionPrompt: string;
  promptLang: McPromptLang;
  /** Duração do provider ('5' | '10'), não a da cena. */
  providerDuration: string;
  attempt: number;
  model?: string;
}

export function computeVideoHashV2(input: VideoHashInputV2): string {
  return computeInputHash(McStepType.VIDEO, MC_BUILDER_VERSIONS_V2.video, {
    keyframeAssetId: input.keyframeAssetId,
    prompt: input.motionPrompt,
    lang: input.promptLang,
    duration: input.providerDuration,
    model: input.model ?? KLING_ACTION_MODEL,
    negativePromptVersion: MC_ACTION_NEGATIVE_PROMPT_VERSION,
    attempt: input.attempt,
  });
}

export interface LipsyncHashInputV2 {
  keyframeAssetId: string;
  audioAssetId: string;
  attempt: number;
  model?: string;
  /** Movimento (EN efetivo) enviado como prompt ao Avatar — mudar a ação regenera. */
  motionPrompt?: string | null;
  promptLang?: McPromptLang | null;
}

export function computeLipsyncHashV2(input: LipsyncHashInputV2): string {
  return computeInputHash(McStepType.LIPSYNC, MC_BUILDER_VERSIONS_V2.lipsync, {
    keyframeAssetId: input.keyframeAssetId,
    audioAssetId: input.audioAssetId,
    model: input.model ?? KLING_AVATAR_MODEL,
    motionPrompt: input.motionPrompt ?? null,
    promptLang: input.promptLang ?? null,
    attempt: input.attempt,
  });
}

export interface SceneComposeHashInput {
  videoAssetId: string;
  audioAssetId: string;
  plannedDurationS: number;
  audioPolicy?: string;
}

/** Hash do scene_compose (ADR §4.2): vídeo + áudio selecionados, política de áudio, duração e versão do compositor. */
export function computeSceneComposeHash(input: SceneComposeHashInput): string {
  return computeInputHash(McStepType.SCENE_COMPOSE, MC_BUILDER_VERSIONS_V2.scene_compose, {
    videoAssetId: input.videoAssetId,
    audioAssetId: input.audioAssetId,
    audioPolicy: input.audioPolicy ?? MC_COMPOSE_AUDIO_POLICY,
    plannedDurationS: input.plannedDurationS,
  });
}

export interface AssemblyHashInputV2 {
  /** Clipes FINAIS efetivos, na ordem de montagem, por identidade de cena. */
  scenes: Array<{ sceneId: string; finalAssetId: string }>;
  seals: Array<{
    sceneId: string;
    productId: string;
    name: string;
    price: string;
    unit: string | null;
    startS: number;
    endS: number;
  }>;
  endcard: string | null;
  musicEnabled: boolean;
  captionsEnabled: boolean;
  aspectRatio: string;
}

/** Hash da montagem v2 (ADR §4.2): não depende de {idx, generation} — conteúdo renderizado é o que conta. */
export function computeAssemblyHashV2(input: AssemblyHashInputV2): string {
  return computeInputHash(McStepType.ASSEMBLY, MC_BUILDER_VERSIONS_V2.assembly, {
    scenes: input.scenes.map((s) => ({ sceneId: s.sceneId, finalAssetId: s.finalAssetId })),
    seals: input.seals.map((s) => ({
      sceneId: s.sceneId,
      productId: s.productId,
      name: s.name,
      price: s.price,
      unit: s.unit,
      startS: s.startS,
      endS: s.endS,
    })),
    endcard: input.endcard,
    musicEnabled: input.musicEnabled,
    captionsEnabled: input.captionsEnabled,
    aspectRatio: input.aspectRatio,
  });
}
