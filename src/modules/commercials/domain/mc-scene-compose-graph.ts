/**
 * Grafo do `scene_compose` (ADR-001 §3.1): vídeo de ação + TTS → clipe final
 * da cena com a locução completa. Funções PURAS (argumentos do ffmpeg e
 * validação de durações); o processor executa via FfmpegRunner.
 *
 * Política de áudio (`replace_clip_audio`): o áudio que o motor de ação
 * eventualmente gerou é DESCARTADO e a locução entra uma única vez — nunca
 * duas vozes. Trilha/ducking/legendas/selos continuam na montagem global.
 *
 * Duração: a locução precisa CABER no clipe (validado ANTES da produção, na
 * aprovação, e de novo aqui com o arquivo real). Áudio mais curto é
 * preenchido com silêncio (`apad`) até o fim do vídeo — o `-t` fixa a saída
 * na duração do VÍDEO, então nunca corta fala (a fala é ≤ vídeo por
 * validação). Não há `-shortest` escondendo corte.
 */

/** Tolerância (ms) para considerar que o áudio "cabe" no clipe (jitter de probe/encoder). */
export const MC_COMPOSE_DURATION_TOLERANCE_MS = 150;

export interface ComposeDurationIssue {
  code: 'audio_exceeds_clip';
  audioMs: number;
  videoMs: number;
  excessMs: number;
}

/** Áudio maior que o clipe (além da tolerância) — bloqueia composição/produção. */
export function composeDurationIssue(
  videoMs: number | null,
  audioMs: number | null,
  toleranceMs: number = MC_COMPOSE_DURATION_TOLERANCE_MS,
): ComposeDurationIssue | null {
  if (videoMs == null || audioMs == null) return null;
  const excess = audioMs - videoMs;
  if (excess > toleranceMs) {
    return { code: 'audio_exceeds_clip', audioMs, videoMs, excessMs: excess };
  }
  return null;
}

/**
 * Cabe no plano? Antes da produção o clipe ainda não existe: comparamos a
 * duração MEDIDA do TTS com a duração que o motor de ação vai entregar
 * (5s ou 10s no Kling). Devolve o excesso em ms (0 = cabe).
 */
export function voiceoverPlanExcessMs(
  audioMs: number,
  providerClipS: number,
  toleranceMs: number = MC_COMPOSE_DURATION_TOLERANCE_MS,
): number {
  const excess = audioMs - providerClipS * 1000;
  return excess > toleranceMs ? excess : 0;
}

export interface SceneComposeArgsOptions {
  videoPath: string;
  audioPath: string;
  output: string;
  /** Duração do VÍDEO medida por probe (segundos, fracionário) — fixa a saída. */
  videoDurationS: number;
}

/**
 * Argumentos do ffmpeg: vídeo copiado (sem re-encode — o clipe do provider já
 * é h264), locução como única trilha de áudio (AAC 48kHz estéreo), `apad`
 * preenche silêncio e `-t` prende a saída à duração do vídeo.
 */
export function buildSceneComposeArgs(opts: SceneComposeArgsOptions): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.videoPath,
    '-i',
    opts.audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-af',
    'apad',
    '-t',
    opts.videoDurationS.toFixed(3),
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    opts.output,
  ];
}

/**
 * Verificação do ARQUIVO composto (não da string do comando): precisa ter
 * vídeo e áudio, e a duração precisa acompanhar a do vídeo de entrada.
 */
export function composedOutputIssue(
  probe: { hasVideo: boolean; hasAudio: boolean; durationMs: number | null },
  videoMs: number,
  toleranceMs: number = MC_COMPOSE_DURATION_TOLERANCE_MS,
): string | null {
  if (!probe.hasVideo) return 'composed_without_video';
  if (!probe.hasAudio) return 'composed_without_audio';
  if (probe.durationMs != null && Math.abs(probe.durationMs - videoMs) > toleranceMs + 100) {
    return 'composed_duration_mismatch';
  }
  return null;
}
