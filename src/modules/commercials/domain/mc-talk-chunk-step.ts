import { computeTalkHashV2, TalkChunkHashInput } from './mc-step-hashes';
import { MC_CUTOUT_KEY_RULE_VERSION } from './mc-cutout-key';
import { TalkChunkPlan } from './mc-talk-chunks';
import { MC_POLL_TIMEOUT_MS } from './mc-pipeline.config';
import { readTalkAudioPadding, talkAudioPadTargetMs } from './mc-talk-engines';
import { talkPollTimeoutMs } from './mc-talk-continuous.config';
import { buildTalkPrompt, TalkPromptCutout } from './mc-talk-prompts';

/**
 * Hash e snapshot do step `talk` de UM TRECHO (change video-fala-continua, D6/D10) — funções PURAS,
 * a MESMA conta da produção e da cotação.
 */

/** Versão do formato do bloco `chunk` do snapshot/hash (D10). */
export const MC_TALK_CHUNK_VERSION = 1;

export interface ChunkStepContext {
  tileAssetId: string;
  tileWidth: number | null;
  tileHeight: number | null;
  backgroundColor: string;
  cutout: TalkPromptCutout | null;
  tier: string | null;
  identityMode: string | null;
  engine: { key: string; model: string; usdPerSecond: number; maxChunkS: number };
}

export interface ChunkStepSpeech {
  sceneRowId: string;
  sceneId: string;
  audioAssetId: string;
}

export interface ChunkStepInput {
  ctx: ChunkStepContext;
  chunk: TalkChunkPlan;
  /** Alinhadas a `chunk.speeches`. */
  speeches: ChunkStepSpeech[];
  /** Junção: `inputHash` do `talk` do trecho anterior e a cena líder dele; `null` no primeiro trecho. */
  join: { fromStepHash: string; fromSceneRowId: string } | null;
  motion: string;
  lang: string;
  sceneType: string | null | undefined;
  attempt: number;
  count: number;
}

export interface ChunkStepOutput {
  inputHash: string;
  /** Hash sem a junção: igual ⇒ o conteúdo do trecho não mudou (a regravação é só cascata). */
  ownHash: string;
  snapshot: Record<string, unknown>;
}

function hashInput(input: ChunkStepInput, joinFromStepHash: string | null): TalkChunkHashInput {
  return {
    version: MC_TALK_CHUNK_VERSION,
    speeches: input.speeches.map((s, i) => ({
      audioAssetId: s.audioAssetId,
      durationMs: input.chunk.speeches[i].durationMs,
    })),
    gapMs: input.chunk.gapMs,
    tailMs: input.chunk.tailMs,
    joinFromStepHash,
    engineAudioMs: input.chunk.sentMs,
  };
}

/** O trecho é "contínuo de verdade" (mais de uma fala, cauda ou junção): usa o prompt contínuo e o bloco no hash. */
export function chunkIsMultiTake(chunk: TalkChunkPlan, hasJoin: boolean): boolean {
  return chunk.speeches.length > 1 || chunk.tailMs > 0 || hasJoin;
}

function talkHash(input: ChunkStepInput, prompt: string, joinHash: string | null): string {
  const { ctx } = input;
  return computeTalkHashV2({
    engineModel: ctx.engine.model,
    tileAssetId: ctx.tileAssetId,
    audioAssetId: input.speeches[0].audioAssetId,
    prompt,
    backgroundColor: ctx.backgroundColor,
    attempt: input.attempt,
    cutout: ctx.cutout ? { ...ctx.cutout, keyRuleVersion: MC_CUTOUT_KEY_RULE_VERSION } : null,
    chunk: hashInput(input, joinHash),
  });
}

export function buildChunkTalkStep(input: ChunkStepInput): ChunkStepOutput {
  const { ctx, chunk } = input;
  const multi = chunkIsMultiTake(chunk, input.join != null);
  const prompt = buildTalkPrompt(input.motion, ctx.cutout, { continuous: multi });
  const joinHash = input.join?.fromStepHash ?? null;
  const inputHash = talkHash(input, prompt, joinHash);
  const ownHash = talkHash(input, prompt, null);
  const snapshot = {
    tileAssetId: ctx.tileAssetId,
    tileWidth: ctx.tileWidth,
    tileHeight: ctx.tileHeight,
    audioAssetId: input.speeches[0].audioAssetId,
    backgroundColor: ctx.backgroundColor,
    ...(ctx.cutout ? { cutout: ctx.cutout, framing: ctx.cutout.framing } : {}),
    motion: input.motion,
    lang: input.lang,
    prompt,
    engine: ctx.engine,
    tier: ctx.tier,
    identityMode: ctx.identityMode,
    sceneType: input.sceneType,
    chunk: {
      version: MC_TALK_CHUNK_VERSION,
      index: chunk.index,
      count: input.count,
      sceneIds: input.speeches.map((s) => s.sceneId),
      sceneRowIds: input.speeches.map((s) => s.sceneRowId),
      speeches: input.speeches.map((s, i) => ({
        sceneId: s.sceneId,
        sceneRowId: s.sceneRowId,
        audioAssetId: s.audioAssetId,
        durationMs: chunk.speeches[i].durationMs,
        startMs: chunk.speeches[i].startMs,
        endMs: chunk.speeches[i].endMs,
      })),
      gapMs: chunk.gapMs,
      tailMs: chunk.tailMs,
      audioMs: chunk.audioMs,
      sentMs: chunk.sentMs,
      offsetMs: chunk.offsetMs,
      ownHash,
      join: input.join
        ? {
            fromChunkIndex: chunk.index - 1,
            fromStepHash: input.join.fromStepHash,
            fromSceneRowId: input.join.fromSceneRowId,
          }
        : null,
    },
  };
  return { inputHash, ownHash, snapshot };
}

/** Bloco `chunk` do snapshot de um step `talk` (forma desconhecida → `null`). */
export interface ChunkSnapshot {
  version: number;
  index: number;
  count: number;
  sceneIds: string[];
  sceneRowIds: string[];
  speeches: Array<{
    sceneId: string;
    sceneRowId: string;
    audioAssetId: string;
    durationMs: number;
    startMs: number;
    endMs: number;
  }>;
  gapMs: number;
  tailMs: number;
  audioMs: number;
  sentMs: number;
  offsetMs: number;
  ownHash: string;
  join: { fromChunkIndex: number; fromStepHash: string; fromSceneRowId: string } | null;
}

export function readChunkSnapshot(snapshot: unknown): ChunkSnapshot | null {
  const chunk = (snapshot as { chunk?: ChunkSnapshot } | null | undefined)?.chunk;
  if (!chunk || !Array.isArray(chunk.speeches) || chunk.speeches.length === 0) return null;
  return chunk;
}

/**
 * Plano do trecho reconstruído do snapshot para o MOTOR EFETIVO: o enchimento único (H3) depende do
 * modelo que realmente recebe o áudio (o fallback de logo → tier muda o mínimo).
 */
export function chunkPlanFromSnapshot(chunk: ChunkSnapshot, model: string): TalkChunkPlan {
  const padTargetMs = talkAudioPadTargetMs(model);
  return {
    index: chunk.index,
    sceneIds: chunk.sceneIds,
    speeches: chunk.speeches.map((s) => ({
      sceneId: s.sceneId,
      durationMs: s.durationMs,
      startMs: s.startMs,
      endMs: s.endMs,
    })),
    gapMs: chunk.gapMs,
    tailMs: chunk.tailMs,
    audioMs: chunk.audioMs,
    sentMs: padTargetMs == null ? chunk.audioMs : Math.max(chunk.audioMs, padTargetMs),
    offsetMs: chunk.offsetMs,
    joinFromIndex: chunk.join ? chunk.join.fromChunkIndex : null,
  };
}

/** Trecho com mais de uma fala ou com cauda de junção precisa da emenda; uma fala solta vai como está (D5.4). */
export function chunkNeedsSplice(chunk: Pick<ChunkSnapshot, 'speeches' | 'tailMs'>): boolean {
  return chunk.speeches.length > 1 || chunk.tailMs > 0;
}

/**
 * Timeout do `provider_wait` de um `talk` (D15): o de hoje (15 min) para a fala solta; para o TRECHO,
 * proporcional aos segundos enviados (`MC_TALK_POLL_PER_AUDIO_S`, piso 15 min, teto 40 min).
 */
export function talkStepPollTimeoutMs(snapshot: unknown): number {
  const chunk = readChunkSnapshot(snapshot);
  if (!chunk) return MC_POLL_TIMEOUT_MS;
  const padding = readTalkAudioPadding((snapshot as { audioPadding?: unknown }).audioPadding);
  return talkPollTimeoutMs(padding?.submittedMs ?? chunk.sentMs);
}
