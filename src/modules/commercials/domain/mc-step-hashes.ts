import { computeInputHash, MC_BUILDER_VERSIONS } from './input-hash';
import { KLING_AVATAR_MODEL } from './mc-pipeline.config';
import { McScriptEndcard, McScriptSeal, McStepType } from './mc-types';

/**
 * Construção dos input_hash por tipo de step (plano-comerciais §6.3) — função
 * pura, fonte única da matriz de invalidação:
 *
 * | Tipo     | Entra no hash                                   | NÃO entra    |
 * |----------|--------------------------------------------------|-------------|
 * | keyframe | actionPrompt, aspectRatio, kit(id+version)       | generation  |
 * | tts      | dialogue, voiceId, cadeia de modelos             | generation  |
 * | video    | keyframeHash, actionPrompt, durationS, generation| —           |
 * | lipsync  | keyframeHash, ttsHash, generation, modelo        | —           |
 * | assembly | [{idx, generation}] das cenas, selo, aspecto     | —           |
 *
 * A GERAÇÃO só entra nos steps "roláveis" (video/lipsync): re-roll
 * (generation++) muda esses hashes e preserva keyframe/tts — que o lookup de
 * cache por usuário resolve como skipped_cached (§6.3: "refaz video(+lipsync),
 * preserva keyframe, tts"). Hashes encadeados (keyframeHash dentro do video)
 * implementam "hashes dos assets de entrada" sem hashear arquivo.
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
}

/** Cadeia de TTS do módulo (plano §5.3): eleven_v3 com fallback multilingual_v2. */
export const MC_TTS_MODEL_CHAIN = 'eleven_v3|eleven_multilingual_v2';

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
 * Hash do assembly: muda quando qualquer cena re-rola (generation) e quando
 * qualquer camada determinística muda — selo (texto OU produtos), cartela
 * final, formato e as opções de trilha/legenda. Re-montagem é step novo
 * (grátis, plano §6.3).
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
