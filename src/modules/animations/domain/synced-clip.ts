/**
 * Clipe sincronizado (spike §3.5) — vídeo do mascote + áudio da fala tratados
 * como UMA unidade pelo editor.
 *
 * O furo que isto fecha: no TDD original áudio e vídeo eram camadas
 * independentes do RenderSpec. Arrastar o mascote no tempo deixava a fala para
 * trás. Aqui o par tem um `startMs` só, e a expansão em duas camadas é
 * mecânica — por construção elas nunca saem com tempos diferentes.
 *
 * Módulo puro: sem I/O, sem dependência de Nest. Testado por contrato.
 */

import type { RenderFormat, RenderLayer } from './ffmpeg-graph-builder';

/**
 * Referência a um arquivo dentro do spec. No spec PERSISTIDO vem `assetId` ou
 * `url`; o worker resolve para `filePath` antes de chamar o builder.
 */
export interface ClipSourceRef {
  assetId?: string;
  url?: string;
}

/** Vídeo do clipe — posição/tamanho em frações do canvas [0..1]. */
export interface SyncedClipVideo extends ClipSourceRef {
  filePath: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Mezanino VP9 yuva420p (alpha real). */
  hasAlpha?: boolean;
  /** Duração intrínseca do arquivo, quando conhecida. */
  durationMs?: number;
}

/** Áudio do clipe — sempre começa junto com o vídeo (offset interno fixo em 0). */
export interface SyncedClipAudio extends ClipSourceRef {
  filePath: string;
  volume?: number;
  /** Duração da fala. Menor que a do vídeo ⇒ o vídeo segue em idle (loop). */
  durationMs?: number;
}

export interface SyncedClipLayer {
  type: 'synced_clip';
  id?: string;
  video: SyncedClipVideo;
  audio: SyncedClipAudio;
  /** Move os DOIS juntos. É o único tempo que a UI expõe. */
  startMs?: number;
  /** Fim do clipe. Ausente ⇒ o vídeo herda a duração total do render. */
  endMs?: number;
  zIndex?: number;
}

export type AnyRenderLayer = RenderLayer | SyncedClipLayer;

export function isSyncedClip(layer: AnyRenderLayer): layer is SyncedClipLayer {
  return layer.type === 'synced_clip';
}

/** Duração mínima por formato de saída (spike §3.5, "mínimo do formato"). */
export const MIN_DURATION_MS_BY_FORMAT: Record<RenderFormat, number> = {
  mp4: 3000,
  webm: 3000,
  gif: 2000,
};

/** Teto do render, casado com o @Max(30000) do RenderSpecDto. */
export const MAX_RENDER_DURATION_MS = 30000;

export class SyncedClipError extends Error {}

/** Instante em que uma camada deixa de aparecer. */
export function layerEndMs(layer: AnyRenderLayer): number {
  const start = layer.startMs ?? 0;
  if (layer.endMs !== undefined) return Math.max(start, layer.endMs);
  if (isSyncedClip(layer)) {
    const intrinsic = Math.max(layer.video.durationMs ?? 0, layer.audio.durationMs ?? 0);
    return start + intrinsic;
  }
  return start;
}

/**
 * Regra de duração final (spike §3.5):
 *   duraçãoFinal = max(fim de todos os clipes, mínimo do formato)
 * limitada pelo teto do render. Camadas de fundo mais curtas continuam sendo
 * resolvidas por `-stream_loop` no builder — não encurtam o resultado.
 */
export function computeFinalDurationMs(
  layers: AnyRenderLayer[],
  format: RenderFormat,
  requestedDurationMs?: number,
): number {
  const longestLayerEnd = layers.reduce((max, layer) => Math.max(max, layerEndMs(layer)), 0);
  const floor = MIN_DURATION_MS_BY_FORMAT[format] ?? 0;
  const raw = Math.max(longestLayerEnd, requestedDurationMs ?? 0, floor);
  return Math.min(Math.round(raw), MAX_RENDER_DURATION_MS);
}

/**
 * Expande cada `synced_clip` em exatamente duas camadas com o **mesmo**
 * `startMs`. Camadas que não são clipe passam intactas, na mesma ordem.
 *
 * Regras aplicadas aqui (spike §3.5):
 * - vídeo sempre com `loop: true` e janela até o fim do clipe (ou do render):
 *   fala mais curta que o total ⇒ idle em loop, **nunca** frame congelado nem
 *   corte seco;
 * - áudio termina quando a fala termina (`audio.durationMs`), sem esticar.
 */
export function expandSyncedClips(
  layers: AnyRenderLayer[],
  totalDurationMs: number,
): RenderLayer[] {
  const expanded: RenderLayer[] = [];
  for (const layer of layers) {
    if (!isSyncedClip(layer)) {
      expanded.push(layer);
      continue;
    }
    if (!layer.video?.filePath || !layer.audio?.filePath) {
      throw new SyncedClipError('Clipe sincronizado exige vídeo e áudio');
    }
    const startMs = Math.max(0, Math.round(layer.startMs ?? 0));
    const clipEndMs = layer.endMs !== undefined ? Math.max(startMs, layer.endMs) : totalDurationMs;
    const speechEndMs =
      layer.audio.durationMs !== undefined
        ? Math.min(startMs + layer.audio.durationMs, clipEndMs)
        : clipEndMs;

    expanded.push({
      type: 'mascot',
      filePath: layer.video.filePath,
      x: layer.video.x,
      y: layer.video.y,
      w: layer.video.w,
      h: layer.video.h,
      startMs,
      endMs: clipEndMs,
      // idle em loop: o vídeo se repete até o fim da janela do clipe
      loop: true,
      zIndex: layer.zIndex,
      hasAlpha: layer.video.hasAlpha,
    });
    expanded.push({
      type: 'audio',
      filePath: layer.audio.filePath,
      // MESMO startMs do vídeo — é a invariante do clipe sincronizado
      startMs,
      endMs: speechEndMs,
      volume: layer.audio.volume,
      zIndex: layer.zIndex,
    });
  }
  return expanded;
}
