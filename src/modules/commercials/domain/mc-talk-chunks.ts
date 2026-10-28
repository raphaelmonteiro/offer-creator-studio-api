import { MC_TALK_GAP_MS, buildSpeechTimeline } from './mc-talk-conform-graph';
import { talkAudioPadTargetMs } from './mc-talk-engines';

/**
 * Trechos de fala contínua (change video-fala-continua, design D4/D5) — funções PURAS.
 * As falas consecutivas que cabem juntas no teto do trecho viram UMA chamada do motor: o
 * áudio enviado é a emenda dos TTS com os silêncios da timeline. Nenhuma fala é dividida,
 * acelerada ou reordenada; os instantes de cada fala são os de `buildSpeechTimeline`.
 */

/** Silêncio depois da última fala de um trecho com sucessor: o último quadro sai de boca fechada (D4). */
export const MC_TALK_JOIN_TAIL_MS = 200;

export interface ChunkSpeechInput {
  sceneId: string;
  /** Duração MEDIDA do TTS (`AnimationAsset.durationMs`). */
  durationMs: number;
}

export interface PlanTalkChunksInput {
  speeches: ChunkSpeechInput[];
  /** Motor do projeto (`MC_TALK_ENGINE_*`): define o mínimo de áudio (H3) e a família. */
  engineModel: string;
  /** `maxChunkS` do motor: teto POR FALA (acima disso a aprovação é bloqueada). */
  engineMaxChunkS: number;
  /** `MC_TALK_CHUNK_MAX_S`; vazio = `engineMaxChunkS`. Sempre limitado por `engineMaxChunkS`. */
  chunkMaxS?: number | null;
  gapMs?: number;
  joinTailMs?: number;
}

export interface TalkChunkSpeech {
  sceneId: string;
  durationMs: number;
  /** Relativos ao início do trecho. */
  startMs: number;
  endMs: number;
}

export interface TalkChunkPlan {
  index: number;
  sceneIds: string[];
  speeches: TalkChunkSpeech[];
  gapMs: number;
  /** Silêncio depois da última fala; 0 no último trecho. */
  tailMs: number;
  /** Σ falas + gaps + cauda. */
  audioMs: number;
  /** Duração do áudio enviado ao motor: `max(audioMs, mínimo do motor + folga)`. */
  sentMs: number;
  /** Onde a 1ª fala do trecho começa na timeline do vídeo (igual a `buildSpeechTimeline`). */
  offsetMs: number;
  /** Índice do trecho cujo último quadro alimenta este (`index - 1`); `null` no primeiro. */
  joinFromIndex: number | null;
}

export interface BlockedSpeech {
  sceneId: string;
  durationMs: number;
  maxMs: number;
}

export interface TalkChunkPlanResult {
  chunks: TalkChunkPlan[];
  /** Falas acima do `maxChunkS` do motor: bloqueiam a aprovação (`SPEECH_SENTENCE_TOO_LONG`); `chunks` vem vazio. */
  blocked: BlockedSpeech[];
}

/** Teto (ms) do trecho: `min(maxChunkS do motor, MC_TALK_CHUNK_MAX_S ?? maxChunkS do motor)`. */
export function talkChunkMaxMs(engineMaxChunkS: number, chunkMaxS?: number | null): number {
  const env = chunkMaxS != null && Number.isFinite(chunkMaxS) && chunkMaxS > 0 ? chunkMaxS : null;
  return Math.round(Math.min(engineMaxChunkS, env ?? engineMaxChunkS) * 1000);
}

function packSpeeches(speeches: ChunkSpeechInput[], chunkMaxMs: number, gapMs: number) {
  const groups: ChunkSpeechInput[][] = [];
  let current: ChunkSpeechInput[] = [];
  let currentMs = 0;
  for (const speech of speeches) {
    const durationMs = Math.max(0, Math.round(speech.durationMs));
    const withNew = current.length === 0 ? durationMs : currentMs + gapMs + durationMs;
    if (current.length > 0 && withNew > chunkMaxMs) {
      groups.push(current);
      current = [];
      currentMs = 0;
    }
    currentMs = current.length === 0 ? durationMs : currentMs + gapMs + durationMs;
    current.push({ sceneId: speech.sceneId, durationMs });
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Agrupa as falas (ordem do roteiro) em trechos pelo guloso em ordem, que minimiza o número de
 * trechos (cada junção custa uma geração serial). Fala sozinha acima do teto do trecho, mas
 * dentro do `maxChunkS` do motor, vira um trecho próprio.
 */
export function planTalkChunks(input: PlanTalkChunksInput): TalkChunkPlanResult {
  const gapMs = input.gapMs ?? MC_TALK_GAP_MS;
  const joinTailMs = input.joinTailMs ?? MC_TALK_JOIN_TAIL_MS;
  const engineMaxMs = Math.round(input.engineMaxChunkS * 1000);
  const chunkMaxMs = talkChunkMaxMs(input.engineMaxChunkS, input.chunkMaxS);
  const blocked = input.speeches
    .filter((s) => Math.round(s.durationMs) > engineMaxMs)
    .map((s) => ({ sceneId: s.sceneId, durationMs: Math.round(s.durationMs), maxMs: engineMaxMs }));
  if (blocked.length > 0) return { chunks: [], blocked };

  const absolute = new Map(
    buildSpeechTimeline(input.speeches, gapMs).entries.map((e) => [e.sceneId, e.startMs]),
  );
  const padTargetMs = talkAudioPadTargetMs(input.engineModel);
  const groups = packSpeeches(input.speeches, chunkMaxMs, gapMs);
  const chunks = groups.map((group, index): TalkChunkPlan => {
    const timeline = buildSpeechTimeline(group, gapMs);
    const hasSuccessor = index < groups.length - 1;
    // A cauda encolhe até caber no teto do trecho (mínimo 0).
    const tailMs = hasSuccessor
      ? Math.max(0, Math.min(joinTailMs, chunkMaxMs - timeline.totalMs))
      : 0;
    const audioMs = timeline.totalMs + tailMs;
    return {
      index,
      sceneIds: group.map((s) => s.sceneId),
      speeches: timeline.entries.map((e, i) => ({
        sceneId: e.sceneId,
        durationMs: group[i].durationMs,
        startMs: e.startMs,
        endMs: e.endMs,
      })),
      gapMs,
      tailMs,
      audioMs,
      sentMs: padTargetMs == null ? audioMs : Math.max(audioMs, padTargetMs),
      offsetMs: absolute.get(group[0].sceneId) ?? 0,
      joinFromIndex: index === 0 ? null : index - 1,
    };
  });
  return { chunks, blocked: [] };
}

// ───────────────────────── emenda do áudio do trecho (D5) ─────────────────────────

export type ChunkSpliceSegment =
  | { kind: 'speech'; sceneId: string; startMs: number; durationMs: number }
  | { kind: 'silence'; reason: 'gap' | 'tail' | 'pad'; startMs: number; durationMs: number };

export interface ChunkSplicePlan {
  segments: ChunkSpliceSegment[];
  /** Duração total do áudio enviado (= `sentMs`). */
  totalMs: number;
  /** Enchimento único ao fim do TRECHO (H3), nunca por fala; 0 quando não há mínimo ou ele já foi atingido. */
  padMs: number;
  /** `true` quando o TTS da única fala pode ir como está (sem cauda nem enchimento). */
  passthrough: boolean;
}

/** Ordem, silêncios e enchimento único da emenda; o processor executa o ffmpeg a partir deste plano. */
export function planChunkAudioSplice(chunk: TalkChunkPlan): ChunkSplicePlan {
  const segments: ChunkSpliceSegment[] = [];
  chunk.speeches.forEach((speech, i) => {
    if (i > 0) {
      const previousEnd = chunk.speeches[i - 1].endMs;
      segments.push({
        kind: 'silence',
        reason: 'gap',
        startMs: previousEnd,
        durationMs: speech.startMs - previousEnd,
      });
    }
    segments.push({
      kind: 'speech',
      sceneId: speech.sceneId,
      startMs: speech.startMs,
      durationMs: speech.durationMs,
    });
  });
  const speechEndMs = chunk.speeches[chunk.speeches.length - 1]?.endMs ?? 0;
  if (chunk.tailMs > 0) {
    segments.push({
      kind: 'silence',
      reason: 'tail',
      startMs: speechEndMs,
      durationMs: chunk.tailMs,
    });
  }
  const padMs = chunk.sentMs - chunk.audioMs;
  if (padMs > 0) {
    segments.push({ kind: 'silence', reason: 'pad', startMs: chunk.audioMs, durationMs: padMs });
  }
  return {
    segments,
    totalMs: chunk.sentMs,
    padMs,
    passthrough: chunk.speeches.length === 1 && chunk.tailMs === 0 && padMs === 0,
  };
}
